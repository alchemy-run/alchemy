// GET /api/jobs — Next's own App Router route handler, answering with the
// queue consumer's async state via the effectful backend. ONE value-form
// client at module scope: in-process RPC needs no headers or per-request
// construction.
import { createClient } from "alchemy/Client";
import Backend from "../../backend.ts";

const backend = createClient(Backend);

export const GET = async (): Promise<Response> =>
  Response.json(await backend.processed());
