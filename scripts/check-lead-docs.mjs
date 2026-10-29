import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const leadId = "563b4a4d-b5bc-40f9-88fc-669a6a74b01e";
const docs = await pool.query(`
  SELECT id, name, doc_type, category, status, file_key, storage_provider, size_bytes,
         lead_id, uploaded_by, uploaded_at, created_at
  FROM documents
  WHERE lead_id = $1
  ORDER BY created_at DESC
  LIMIT 20
`, [leadId]);
console.log("docs", docs.rows);
const viewers = await pool.query(`
  SELECT dv.document_id, dv.user_id, u.full_name
  FROM document_viewers dv
  JOIN users u ON u.id = dv.user_id
  WHERE dv.document_id = ANY($1::uuid[])
`, [docs.rows.map((r) => r.id)]);
console.log("viewers", viewers.rows);
const lead = await pool.query(`
  SELECT id, full_name, owner_user_id, team_id FROM leads WHERE id = $1
`, [leadId]);
console.log("lead", lead.rows[0]);
await pool.end();
