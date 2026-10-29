import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const users = await pool.query(`
  SELECT u.id, u.full_name, u.email, r.code
  FROM users u JOIN roles r ON r.id = u.role_id
  WHERE u.id IN (
    'f38dd9b0-403f-4132-9f24-9975a280284d',
    '617f590e-901a-4846-84ad-0a557e8d6c41'
  )
`);
console.log(users.rows);

// Can SE see screenshot on their lead via own-scope logic?
const lead = await pool.query(`
  SELECT id, full_name, owner_user_id FROM leads WHERE id = '015d5a68-4a5e-4adb-a717-278a0e0890ee'
`);
console.log("lead with ss", lead.rows[0]);

const viewers = await pool.query(`
  SELECT * FROM document_viewers WHERE document_id = '9d20571f-7a11-4feb-8dcf-1648868774e2'
`);
console.log("viewers for ss", viewers.rows);

await pool.end();
