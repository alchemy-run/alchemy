import { DurableObject } from "cloudflare:workers";
import type { AsyncWorkerEnv } from "../alchemy.run.ts";

export default {
  async fetch(_request, env) {
    const counter = env.Counter.getByName("my-counter");
    const count = await counter.increment();
    return new Response(`Hello, world! ${count}`);
  },
} satisfies ExportedHandler<AsyncWorkerEnv>;

export class Counter extends DurableObject {
  async increment() {
    return ++this.counter;
  }

  get counter() {
    return this.ctx.storage.kv.get<number>("counter") ?? 0;
  }

  set counter(value: number) {
    this.ctx.storage.kv.put("counter", value);
  }
}
