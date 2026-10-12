import type pg from "pg";
import { hashPassword } from "../modules/auth/password.js";
import { logger } from "../logger.js";

const SUPER_ADMIN_ROLE_ID = "11111111-1111-1111-1111-111111111111";
const DEFAULT_ADMIN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

export interface SeedOptions {
  production: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Creates the initial Super Admin when the users table is empty; otherwise does nothing,
 * so it is safe to run repeatedly. Same behavior as the Go SeedBootstrapAdmin, which falls
 * back to the well-known default credentials; production only adds a warning.
 */
export async function seedBootstrapAdmin(pool: pg.Pool, { production, env = process.env }: SeedOptions): Promise<boolean> {
  const { rows } = await pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users");
  if ((rows[0]?.count ?? 0) > 0) return false;

  const email = env.BOOTSTRAP_ADMIN_EMAIL || "admin@crm.local";
  const password = env.BOOTSTRAP_ADMIN_PASSWORD || "ChangeMe123!";
  const name = env.BOOTSTRAP_ADMIN_NAME || "Super Admin";
  if (production && (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD)) {
    logger.warn("bootstrap super admin uses default credentials; set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD");
  }

  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name, role_id, is_active)
     VALUES ($1, lower($2), $3, $4, $5, TRUE)
     ON CONFLICT DO NOTHING`,
    [DEFAULT_ADMIN_ID, email, hash, name, SUPER_ADMIN_ROLE_ID],
  );
  logger.info({ email }, "bootstrap super admin created");
  return true;
}
