import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const docs = await pool.query(`
  SELECT d.id, d.name, d.doc_type, d.category, d.status, d.file_key, d.storage_provider,
         d.size_bytes, d.lead_id, d.uploaded_by, u.full_name AS uploader, d.created_at
  FROM documents d
  LEFT JOIN users u ON u.id = d.uploaded_by
  WHERE d.doc_type ILIKE '%screenshot%' OR d.category ILIKE '%screenshot%' OR d.name ILIKE '%screenshot%'
  ORDER BY d.created_at DESC
  LIMIT 15
`);
console.log("screenshots", docs.rows);

const recent = await pool.query(`
  SELECT d.id, d.name, d.doc_type, d.status, left(d.file_key, 60) AS file_key, d.lead_id,
         d.uploaded_by, d.created_at
  FROM documents d
  ORDER BY d.created_at DESC
  LIMIT 15
`);
console.log("recent docs", recent.rows);

const tl = await pool.query(`
  SELECT te.id, te.event_type, te.title, te.body, te.lead_id, te.document_id, te.occurred_at, te.metadata
  FROM timeline_events te
  WHERE te.event_type LIKE 'document%'
  ORDER BY te.occurred_at DESC
  LIMIT 10
`);
console.log("timeline", tl.rows);

await pool.end();
