import { getContainer } from "@cloudflare/containers";
import type { worker } from "../alchemy.run.ts";

// the class must be exported for Cloudflare
export { MyContainer } from "./container.ts";

export default {
  async fetch(request: Request, env: typeof worker.Env): Promise<Response> {
    const container = getContainer(env.CONTAINER, "container");
    return container.fetch(request);
  },
};
