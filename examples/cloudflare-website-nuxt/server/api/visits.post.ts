// POST /api/visits — bump the counter through the trusted in-process form.
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export default defineEventHandler(async (event) => {
  const backend = createClient(Backend, { headers: event.headers });
  return { count: await backend.bump() };
});
