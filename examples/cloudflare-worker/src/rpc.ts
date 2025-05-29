import { WorkerEntrypoint } from "cloudflare:workers";

export default class MyRPC extends WorkerEntrypoint {
  /**
   * Hello world
   */
  async hello(name: string) {
    return `Hello, ${name}!`;
  }
  async fetch() {
    return new Response("Hello from Worker B");
  }
}
