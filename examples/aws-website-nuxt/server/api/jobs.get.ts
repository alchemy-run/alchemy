// GET /api/jobs — the queue consumer's async state, read back from KV.
// The value-form client dispatches in-process RPC: no headers are needed
// (methods that must self-authorize take them explicitly), so ONE client
// at module scope serves every request.
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

const backend = createClient(Backend);

export default defineEventHandler(async () => {
  return await backend.processed();
});
