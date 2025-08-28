import { DurableObject } from "cloudflare:workers";

/**
 * A simple Hello World Durable Object
 */
export class HelloWorldDO extends DurableObject {
  async increment() {
    // Get the current count from storage or initialize to 0
    const count = ((await this.ctx.storage.get<number>("count")) ?? -1) + 1;

    // Store the updated count
    await this.ctx.storage.put("count", count);

    return count;
  }
}
