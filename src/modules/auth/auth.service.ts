import { AppError } from "../../lib/app-error.js";
import { expandImpliesScoped, type ScopeMap } from "../permissions/permissions.js";
import type { AuthRepository } from "./auth.repository.js";
import { comparePassword, hashPassword } from "./password.js";
import { REFRESH_TOKEN_TTL_MS, hashRefreshToken, newRefreshToken, type JwtService } from "./tokens.js";
import type { Claims, SessionUser, TokenPair, UserRecord } from "./types.js";

export interface UpdateProfileInput {
  fullName?: string | undefined;
  phone?: string | undefined;
  timezone?: string | undefined;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface AuthResult {
  pair: TokenPair;
  user: SessionUser;
}

/** Wraps repository failures the way the Go service does: apperrors.Internal(message, err). */
async function db<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw AppError.internal(message, err);
  }
}

/**
 * Approximates Go's time.LoadLocation: IANA names (case-sensitive, aliases allowed), "UTC" and "Local".
 * ICU matches names case-insensitively and accepts offsets like "+05:45"; Go rejects both.
 */
export function isValidTimezone(tz: string): boolean {
  if (tz === "UTC" || tz === "Local") return true;
  if (!/^[A-Z][A-Za-z0-9_+\-]*(\/[A-Z][A-Za-z0-9_+\-]*)*$/.test(tz)) return false;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  return resolved.toLowerCase() !== tz.toLowerCase() || resolved === tz;
}

const DEFAULT_TIMEZONE = "Asia/Kathmandu";
const coalesceTz = (tz: string) => (tz.trim() === "" ? DEFAULT_TIMEZONE : tz);

export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly jwt: JwtService,
  ) {}

  async login(emailRaw: string, password: string, userAgent: string, ip: string): Promise<AuthResult> {
    const email = emailRaw.trim().toLowerCase();
    if (email === "" || password === "") {
      throw AppError.validation("email and password are required");
    }
    const user = await db("failed to look up user", () => this.repo.findUserByEmail(email));
    if (!user || !(await comparePassword(user.passwordHash, password))) {
      throw AppError.unauthorized("invalid email or password");
    }
    if (!user.isActive) throw AppError.unauthorized("account is deactivated");

    const result = await this.issueSession(user, userAgent, ip);
    await this.repo.touchLastLogin(user.id).catch(() => undefined);
    return result;
  }

  async logout(refreshToken: string): Promise<void> {
    if (refreshToken === "") return;
    await this.repo.revokeRefreshSession(hashRefreshToken(refreshToken));
  }

  async refresh(refreshToken: string, userAgent: string, ip: string): Promise<AuthResult> {
    if (refreshToken === "") throw AppError.unauthorized("refresh token required");
    const hash = hashRefreshToken(refreshToken);
    const session = await db("failed to load session", () => this.repo.findRefreshSession(hash));
    if (!session || session.revoked || Date.now() > session.expiresAt.getTime()) {
      throw AppError.unauthorized("session expired");
    }

    const user = await db("failed to load user", () => this.repo.findUserById(session.userId));
    if (!user || !user.isActive) {
      await this.repo.revokeRefreshSession(hash).catch(() => undefined);
      throw AppError.unauthorized("account is deactivated");
    }

    const next = newRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    await db("failed to rotate session", () =>
      this.repo.rotateRefreshSession(hash, next.hash, userAgent, ip, refreshExpiresAt),
    );

    const access = this.issueAccess(user);
    const sessionUser = await this.buildSessionUser(user);
    return {
      pair: {
        accessToken: access.token,
        refreshToken: next.raw,
        accessExpiresAt: access.expiresAt,
        refreshExpiresAt,
      },
      user: sessionUser,
    };
  }

  async me(accessToken: string): Promise<SessionUser> {
    const user = await this.loadActiveUserFromToken(accessToken);
    return this.buildSessionUser(user);
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<SessionUser> {
    const user = await this.loadActiveUser(userId);

    let fullName = user.fullName;
    if (input.fullName !== undefined) {
      fullName = input.fullName.trim();
      if (fullName === "") throw AppError.validation("full name is required");
    }
    let phone = user.phone;
    if (input.phone !== undefined) phone = input.phone.trim();
    let tz = coalesceTz(user.timezone);
    if (input.timezone !== undefined) {
      tz = input.timezone.trim();
      if (tz === "") throw AppError.validation("timezone is required");
      if (!isValidTimezone(tz)) throw AppError.validation("invalid IANA timezone");
    }

    await db("failed to update profile", () => this.repo.updateProfile(userId, fullName, phone, tz));
    return this.buildSessionUser({ ...user, fullName, phone, timezone: tz });
  }

  /**
   * Verifies the current password, sets a new hash, revokes all refresh sessions,
   * and issues a fresh session so the current device stays signed in.
   */
  async changePassword(userId: string, input: ChangePasswordInput, userAgent: string, ip: string): Promise<AuthResult> {
    if (input.currentPassword.trim() === "") throw AppError.validation("current password is required");
    if (Buffer.byteLength(input.newPassword) < 8) throw AppError.validation("password must be at least 8 characters");
    if (input.currentPassword === input.newPassword) {
      throw AppError.validation("new password must be different from the current password");
    }

    const user = await this.loadActiveUser(userId);
    if (!(await comparePassword(user.passwordHash, input.currentPassword))) {
      throw AppError.unauthorized("current password is incorrect");
    }

    const hash = await db("failed to hash password", () => hashPassword(input.newPassword));
    await db("failed to update password", () => this.repo.updatePasswordHash(userId, hash));
    await this.repo.revokeAllUserSessions(userId).catch(() => undefined);

    return this.issueSession({ ...user, passwordHash: hash }, userAgent, ip);
  }

  /** Validates an access token and loads the caller's claims (permissions, teams) fresh from the DB. */
  async authenticateAccessToken(accessToken: string): Promise<Claims> {
    const parsed = this.parseToken(accessToken);
    const user = await this.loadActiveUser(parsed.uid);

    const grants = await db("failed to load permissions", () => this.repo.listPermissionGrants(user.roleId));
    const scopes = expandImpliesScoped(grants);
    const teamIds = await db("failed to load teams", () => this.repo.listTeamIds(user.id));
    const teamMemberUserIds = await db("failed to load team members", () =>
      this.repo.listTeamMemberUserIds(user.id),
    );

    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      roleCode: user.roleCode,
      roleId: user.roleId,
      teamIds,
      teamMemberUserIds,
      permissions: Object.keys(scopes),
      permissionScopes: scopes,
      expiresAt: new Date(parsed.exp * 1000),
    };
  }

  private parseToken(accessToken: string) {
    try {
      return this.jwt.parseAccessToken(accessToken);
    } catch {
      throw AppError.unauthorized("invalid or expired session");
    }
  }

  private async loadActiveUserFromToken(accessToken: string): Promise<UserRecord> {
    return this.loadActiveUser(this.parseToken(accessToken).uid);
  }

  private async loadActiveUser(userId: string): Promise<UserRecord> {
    const user = await db("failed to load user", () => this.repo.findUserById(userId));
    if (!user || !user.isActive) throw AppError.unauthorized("account is deactivated");
    return user;
  }

  private issueAccess(user: UserRecord) {
    try {
      return this.jwt.issueAccessToken(user.id, user.email, user.roleCode);
    } catch (err) {
      throw AppError.internal("failed to issue access token", err);
    }
  }

  private async issueSession(user: UserRecord, userAgent: string, ip: string): Promise<AuthResult> {
    const access = this.issueAccess(user);
    const refresh = newRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    await db("failed to persist session", () =>
      this.repo.createRefreshSession(user.id, refresh.hash, userAgent, ip, refreshExpiresAt),
    );
    const sessionUser = await this.buildSessionUser(user);
    return {
      pair: {
        accessToken: access.token,
        refreshToken: refresh.raw,
        accessExpiresAt: access.expiresAt,
        refreshExpiresAt,
      },
      user: sessionUser,
    };
  }

  private async buildSessionUser(user: UserRecord): Promise<SessionUser> {
    const grants = await db("failed to load permissions", () => this.repo.listPermissionGrants(user.roleId));
    // Go's JSON encoder writes map keys sorted.
    const scopes: ScopeMap = Object.fromEntries(
      Object.entries(expandImpliesScoped(grants)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const teamIds = await db("failed to load teams", () => this.repo.listTeamIds(user.id));
    const session: SessionUser = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roleCode: user.roleCode,
      roleName: user.roleName,
      isActive: user.isActive,
      timezone: coalesceTz(user.timezone),
      phone: user.phone,
      teamIds: teamIds.length > 0 ? teamIds : null,
      permissions: Object.keys(scopes),
    };
    if (Object.keys(scopes).length > 0) session.permissionScopes = scopes;
    return session;
  }
}
