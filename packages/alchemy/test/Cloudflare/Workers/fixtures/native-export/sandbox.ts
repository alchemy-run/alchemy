import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Sandbox extends DurableObject {
  ping(): string {
    return "sandbox:pong";
  }
}

export class RepoProxy extends WorkerEntrypoint {
  override fetch(): Response {
    return new Response("repo-proxy:ok");
  }
}
