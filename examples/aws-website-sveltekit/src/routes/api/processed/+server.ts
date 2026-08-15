// A framework API route: the JSON surface the page polls while the sibling
// queue consumer catches up. Same trusted value-form client as
// +page.server.ts — the backend method runs in-process, only this route's
// JSON crosses the trust boundary.
import { json } from "@sveltejs/kit";
import { createClient } from "alchemy/Client";
import Backend from "../../../backend.ts";

export const GET = async ({ request }: { request: Request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return json(await backend.processed());
};
