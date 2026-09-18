import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { FunctionTriggerEnvelope } from "alchemy/Neon";
import * as Schema from "effect/Schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
attachDatabasePool(pool);
export default {
  async fetch(request: Request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const invocation = request.headers.get("x-neon-trigger-invocation-id");
    if (!invocation) return new Response(null, { status: 403 });
    let event: FunctionTriggerEnvelope;
    try {
      event = Schema.decodeUnknownSync(FunctionTriggerEnvelope)(
        await request.json(),
      );
    } catch {
      return new Response(null, { status: 400 });
    }
    if (event.invocation_id !== invocation)
      return new Response(null, { status: 400 });
    await pool.query(
      "CREATE TABLE IF NOT EXISTS native_events (invocation_id text PRIMARY KEY, event jsonb NOT NULL)",
    );
    await pool.query(
      "INSERT INTO native_events VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [invocation, event],
    );
    return new Response(null, { status: 204 });
  },
};
