import type { Response, Router } from "express";
import { createRouter } from "../../lib/router.js";
import { z } from "zod";
import type { Config } from "../../config.js";
import { ok } from "../../lib/response.js";
import { decodeJson, optionalString, str } from "../../lib/validate.js";
import { jsonBody } from "../../middleware/errors.js";
import { authenticate, claimsOf } from "./auth.middleware.js";
import type { AuthResult, AuthService } from "./auth.service.js";
import { clearAuthCookies, clientIp, extractBearer, refreshTokenFromRequest, setAuthCookies } from "./cookies.js";
import { formatRfc3339 } from "./tokens.js";

const loginSchema = z.strictObject({ email: str(), password: str() });
const updateProfileSchema = z.strictObject({
  fullName: optionalString(),
  phone: optionalString(),
  timezone: optionalString(),
});
const changePasswordSchema = z.strictObject({ currentPassword: str(), newPassword: str() });

export function authRouter(service: AuthService, cfg: Config): Router {
  const router = createRouter();
  const auth = authenticate(service);

  const sendAuth = (res: Response, { pair, user }: AuthResult) => {
    setAuthCookies(res, cfg, pair);
    ok(res, {
      user,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresAt: formatRfc3339(pair.accessExpiresAt),
      refreshExpiresAt: formatRfc3339(pair.refreshExpiresAt),
    });
  };

  router.post("/api/v1/auth/login", jsonBody, async (req, res) => {
    const { email, password } = decodeJson(req, loginSchema);
    sendAuth(res, await service.login(email, password, req.get("User-Agent") ?? "", clientIp(req)));
  });

  router.post("/api/v1/auth/logout", async (req, res) => {
    await service.logout(refreshTokenFromRequest(req)).catch(() => undefined);
    clearAuthCookies(res, cfg);
    ok(res, { loggedOut: true });
  });

  router.post("/api/v1/auth/refresh", async (req, res) => {
    try {
      sendAuth(res, await service.refresh(refreshTokenFromRequest(req), req.get("User-Agent") ?? "", clientIp(req)));
    } catch (err) {
      clearAuthCookies(res, cfg);
      throw err;
    }
  });

  router.get("/api/v1/auth/me", auth, async (req, res) => {
    claimsOf(req);
    ok(res, await service.me(extractBearer(req)));
  });

  router.patch("/api/v1/auth/me", auth, jsonBody, async (req, res) => {
    const claims = claimsOf(req);
    const input = decodeJson(req, updateProfileSchema);
    ok(res, await service.updateProfile(claims.userId, input));
  });

  router.post("/api/v1/auth/change-password", auth, jsonBody, async (req, res) => {
    const claims = claimsOf(req);
    const input = decodeJson(req, changePasswordSchema);
    sendAuth(
      res,
      await service.changePassword(claims.userId, input, req.get("User-Agent") ?? "", clientIp(req)),
    );
  });

  return router;
}
