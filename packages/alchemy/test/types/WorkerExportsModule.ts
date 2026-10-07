// Worker module for the `WorkerExports.ts` type probe. It imports
// `WorkerEnv` back from the probe, reproducing the module ↔ stack type
// cycle every async Worker has.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { WorkerEnv } from "./WorkerExports.ts";

export class Counter extends DurableObject<WorkerEnv> {
  count = 0;
  async increment(): Promise<number> {
    return ++this.count;
  }
}

export class Legacy extends DurableObject<WorkerEnv> {}

export class CachedRead extends WorkerEntrypoint<WorkerEnv> {
  async read(key: string): Promise<string> {
    return key;
  }
}

export const helper = (): number => 1;

export default {
  async fetch(_request: Request, env: WorkerEnv): Promise<Response> {
    const count = await env.Counter.getByName("probe").increment();
    const self = await env.MCP.fetch("https://self.internal");
    return new Response(`${count} ${self.status}`);
  },
} satisfies ExportedHandler<WorkerEnv>;
