// GET /api/jobs — the queue consumer's async state, read back from KV.
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export default defineEventHandler(async (event) => {
  const backend = createClient(Backend, { headers: event.headers });
  return await backend.processed();
});
