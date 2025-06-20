import type { worker2 } from "../alchemy.run.ts";

export default {
  async fetch(
    request: Request,
    env: typeof worker2.Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return env.WORKER.fetch(request);
  },
};
