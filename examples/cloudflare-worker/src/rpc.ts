import { WorkerEntrypoint } from "cloudflare:workers";

export class MyRPC extends WorkerEntrypoint {
  /**
   * Hello world
   */
  async hello(name: string) {
    return `Hello, ${name}!`;
  }
}
