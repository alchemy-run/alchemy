// Nitro server routes are the public API. Inside them the backend is a
// trusted, in-process call: value-import the class and dispatch through
// `createClient` — no HTTP hop, no serialization.
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export default defineEventHandler(async (event) => {
  const backend = createClient(Backend, { headers: event.headers });
  return { count: await backend.visits() };
});
