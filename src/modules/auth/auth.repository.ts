import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.js";
import type { Grant, MaybeScope } from "../permissions/permissions.js";
import type { UserRecord } from "./types.js";

export interface RefreshSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  revoked: boolean;
}

export class AuthRepository {
  constructor(private readonly db: Database) {}

  private userQuery() {
    return this.db
      .selectFrom("users as u")
      .innerJoin("roles as r", "r.id", "u.role_id")
      .select([
        "u.id",
        "u.email",
        "u.password_hash as passwordHash",
        "u.full_name as fullName",
        sql<string>`COALESCE(u.phone, '')`.as("phone"),
        "u.role_id as roleId",
        "r.code as roleCode",
        "r.name as roleName",
        "u.is_active as isActive",
        "u.timezone",
      ]);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return (await this.userQuery().where("u.email", "=", email).executeTakeFirst()) ?? null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return (await this.userQuery().where("u.id", "=", id).executeTakeFirst()) ?? null;
  }

  async listPermissionGrants(roleId: string): Promise<Grant[]> {
    const rows = await this.db
      .selectFrom("role_permissions as rp")
      .innerJoin("permissions as p", "p.id", "rp.permission_id")
      .select(["p.code", sql<string>`COALESCE(rp.scope, 'organization')`.as("scope")])
      .where("rp.role_id", "=", roleId)
      .orderBy("p.code")
      .execute();
    return rows.map((r) => ({ code: r.code, scope: r.scope as MaybeScope }));
  }

  async listTeamIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("team_members")
      .select(sql<string>`team_id::text`.as("teamId"))
      .where("user_id", "=", userId)
      .execute();
    return rows.map((r) => r.teamId);
  }

  /** Distinct user IDs that share any team with userId. */
  async listTeamMemberUserIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("team_members as tm")
      .innerJoin("team_members as tm2", "tm2.team_id", "tm.team_id")
      .select(sql<string>`tm2.user_id::text`.as("userId"))
      .distinct()
      .where("tm.user_id", "=", userId)
      .execute();
    return rows.map((r) => r.userId);
  }

  async touchLastLogin(userId: string): Promise<void> {
    await this.db.updateTable("users").set({ last_login_at: sql`NOW()` }).where("id", "=", userId).execute();
  }

  async createRefreshSession(userId: string, tokenHash: string, ua: string, ip: string, expiresAt: Date): Promise<string> {
    const id = randomUUID();
    await this.db
      .insertInto("refresh_sessions")
      .values({ id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, user_agent: ua, ip_address: ip })
      .execute();
    return id;
  }

  async findRefreshSession(tokenHash: string): Promise<RefreshSession | null> {
    const row = await this.db
      .selectFrom("refresh_sessions")
      .select([
        sql<string>`id::text`.as("sessionId"),
        sql<string>`user_id::text`.as("userId"),
        "expires_at as expiresAt",
        "revoked_at as revokedAt",
      ])
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    if (!row) return null;
    return { sessionId: row.sessionId, userId: row.userId, expiresAt: row.expiresAt, revoked: row.revokedAt !== null };
  }

  async revokeRefreshSession(tokenHash: string): Promise<void> {
    await this.db
      .updateTable("refresh_sessions")
      .set({ revoked_at: sql`NOW()` })
      .where("token_hash", "=", tokenHash)
      .where("revoked_at", "is", null)
      .execute();
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.db
      .updateTable("refresh_sessions")
      .set({ revoked_at: sql`NOW()` })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /** Revokes oldHash and inserts newHash in one transaction; throws if oldHash was already revoked. */
  async rotateRefreshSession(oldHash: string, newHash: string, ua: string, ip: string, expiresAt: Date): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const revoked = await tx
        .updateTable("refresh_sessions")
        .set({ revoked_at: sql`NOW()` })
        .where("token_hash", "=", oldHash)
        .where("revoked_at", "is", null)
        .returning(sql<string>`user_id::text`.as("userId"))
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("refresh_sessions")
        .values({
          id: randomUUID(),
          user_id: revoked.userId,
          token_hash: newHash,
          expires_at: expiresAt,
          user_agent: ua,
          ip_address: ip,
        })
        .execute();
    });
  }

  async updateProfile(userId: string, fullName: string, phone: string, timezone: string): Promise<void> {
    await this.db
      .updateTable("users")
      .set({ full_name: fullName, phone, timezone, updated_at: sql`NOW()` })
      .where("id", "=", userId)
      .execute();
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db
      .updateTable("users")
      .set({ password_hash: passwordHash, updated_at: sql`NOW()` })
      .where("id", "=", userId)
      .execute();
  }
}
