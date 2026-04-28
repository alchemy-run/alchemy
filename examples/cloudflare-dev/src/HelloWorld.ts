import { DurableObject } from "cloudflare:workers";
import type { HelloWorldEnv } from "../alchemy.run.ts";

export default {
  async fetch(_request, env) {
    const counter = env.Counter.getByName("my-counter");
    const count = await counter.increment();
    return new Response(`Hello, world! ${count}`);
  },
} satisfies ExportedHandler<HelloWorldEnv>;

export class Counter extends DurableObject {
  private counter = 0;
  async increment() {
    return ++this.counter;
  }
}
