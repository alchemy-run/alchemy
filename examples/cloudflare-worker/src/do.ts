import { DurableObject } from "cloudflare:workers";

/**
 * A simple Hello World Durable Object
 */
export class HelloWorldDO extends DurableObject {
  async increment() {
    // Get the current count from storage or initialize to 0
    let count = (await this.ctx.storage.get("count")) || 0;

    // Store the updated count
    await this.ctx.storage.put("count", count);

    return count;
  }

  /**
   * Handle HTTP requests to the Durable Object
   */
  async fetch(_request: Request): Promise<Response> {
    const count = await this.increment();

    // Return a response with the count
    return new Response(
      JSON.stringify({
        message: "Hello World from Durable Object!",
        count: count,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
}
