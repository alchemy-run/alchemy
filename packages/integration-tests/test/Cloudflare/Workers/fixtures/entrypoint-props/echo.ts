import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * A named entrypoint, echoing its props, that `effect-worker.ts` serves through
 * `entrypoints: { Echo: { from: "./echo.ts" } }`. Only the generated entry
 * imports it: planning, which loads the Effect Worker's module outside
 * workerd, never reaches `cloudflare:workers`.
 */
export class Echo extends WorkerEntrypoint {
  fetch() {
    return new Response(`props=${JSON.stringify(this.ctx.props ?? {})}`);
  }
}
