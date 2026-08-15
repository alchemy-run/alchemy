// POST /api/jobs — enqueue a message; the consumer on the backend class
// catches up asynchronously (poll GET /api/jobs to watch it land).
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export default defineEventHandler(async (event) => {
  const { message } = await readBody<{ message?: string }>(event);
  const backend = createClient(Backend, { headers: event.headers });
  await backend.enqueue(message || "hello queue");
  return { enqueued: true };
});
