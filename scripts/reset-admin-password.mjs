/**
 * One-shot: list Super Admins, then set a temporary password on the chosen account.
 * Usage: node --env-file=.env scripts/reset-admin-password.mjs [email] [newPassword]
 */
import pg from "pg";
import bcrypt from "bcryptjs";

const emailArg = process.argv[2];
const newPassword = process.argv[3] || "ChangeMe123!";

if (Buffer.byteLength(newPassword, "utf8") < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const { rows: admins } = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.is_active, r.code AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.code = 'super_admin'
     ORDER BY u.created_at`,
  );

  if (admins.length === 0) {
    console.error("No Super Admin users found.");
    process.exit(1);
  }

  console.log("Super Admins:");
  for (const a of admins) {
    console.log(`  ${a.email}  (${a.full_name}, active=${a.is_active})`);
  }

  const target = emailArg
    ? admins.find((a) => a.email.toLowerCase() === emailArg.toLowerCase())
    : admins[0];

  if (!target) {
    console.error(`No Super Admin with email: ${emailArg}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query(
    `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
    [target.id, hash],
  );

  console.log("");
  console.log(`Password reset for ${target.email}`);
  console.log(`Temporary password: ${newPassword}`);
  console.log("Sign in, then change it under Profile.");
} finally {
  await pool.end();
}
