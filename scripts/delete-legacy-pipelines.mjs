/**
 * Deactivate (and hard-delete when unused) the seed pipelines:
 * Lead Qualification, Sales Pipeline, Development Pipeline.
 *
 * Usage: node --env-file=.env scripts/delete-legacy-pipelines.mjs
 */
import pg from "pg";

const TARGET_NAMES = ["Lead Qualification", "Sales Pipeline", "Development Pipeline"];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function count(table, col, id) {
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${col} = $1`, [id]);
    return r.rows[0].c;
  } catch {
    return 0;
  }
}

try {
  const { rows: pipelines } = await pool.query(
    `SELECT id, name, kind, is_default, is_active
     FROM pipelines
     WHERE name = ANY($1::text[])
     ORDER BY name`,
    [TARGET_NAMES],
  );

  if (pipelines.length === 0) {
    console.log("None of those pipelines exist.");
    process.exit(0);
  }

  for (const p of pipelines) {
    const refs = {
      leads: await count("leads", "pipeline_id", p.id),
      deals: await count("deals", "pipeline_id", p.id),
      customers: await count("customers", "pipeline_id", p.id),
      targets: await count("targets", "pipeline_id", p.id),
      custom_fields: await count("custom_fields", "pipeline_id", p.id),
      lead_stage_from: await count("lead_stage_transitions", "from_pipeline_id", p.id),
      lead_stage_to: await count("lead_stage_transitions", "to_pipeline_id", p.id),
      deal_stage_from: await count("deal_stage_transitions", "from_pipeline_id", p.id),
      deal_stage_to: await count("deal_stage_transitions", "to_pipeline_id", p.id),
    };
    const live = refs.leads + refs.deals + refs.customers + refs.targets + refs.custom_fields;
    const history = refs.lead_stage_from + refs.lead_stage_to + refs.deal_stage_from + refs.deal_stage_to;

    console.log(`\n${p.name} (${p.kind})`);
    console.log(`  id=${p.id} active=${p.is_active} default=${p.is_default}`);
    console.log(`  live refs: leads=${refs.leads} deals=${refs.deals} customers=${refs.customers} targets=${refs.targets} custom_fields=${refs.custom_fields}`);
    console.log(`  history: ${history}`);

    // Always clear default + deactivate so they drop out of normal pickers.
    await pool.query(
      `UPDATE pipelines SET is_active = FALSE, is_default = FALSE, updated_at = NOW() WHERE id = $1`,
      [p.id],
    );
    await pool.query(
      `UPDATE pipeline_stages SET is_active = FALSE WHERE pipeline_id = $1`,
      [p.id],
    );

    if (live === 0 && history === 0) {
      await pool.query(`DELETE FROM pipeline_stages WHERE pipeline_id = $1`, [p.id]);
      await pool.query(`DELETE FROM pipelines WHERE id = $1`, [p.id]);
      console.log("  → hard-deleted (no live or history references)");
    } else if (live === 0) {
      console.log("  → deactivated (kept for stage-history references)");
    } else {
      console.log("  → deactivated (still has live records; reassign those before a hard delete)");
    }
  }

  // If Sales was the default sales pipeline, pick another active sales pipeline as default.
  const { rows: defaults } = await pool.query(
    `SELECT id, name FROM pipelines WHERE kind = 'sales' AND is_default = TRUE`,
  );
  if (defaults.length === 0) {
    const { rows: next } = await pool.query(
      `SELECT id, name FROM pipelines
       WHERE kind = 'sales' AND is_active = TRUE
       ORDER BY name
       LIMIT 1`,
    );
    if (next[0]) {
      await pool.query(`UPDATE pipelines SET is_default = TRUE, updated_at = NOW() WHERE id = $1`, [next[0].id]);
      console.log(`\nNew default sales pipeline: ${next[0].name}`);
    } else {
      console.log("\nNo active sales pipeline left to mark as default.");
    }
  }

  console.log("\nDone.");
} finally {
  await pool.end();
}
