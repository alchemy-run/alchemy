import { WorkerEntrypoint } from "cloudflare:workers";

// Missing-entrypoint responses used by the pre-invocation Alchemy bridges.
export class LegacyWorker extends WorkerEntrypoint {
  __alchemy_rpc_invoke__(): never {
    throw new Error(
      "Method \"__alchemy_rpc_invoke__\" not found on worker. Make sure it's returned from the worker's default export.",
    );
  }

  echo(value: string) {
    return value;
  }

  fail(): never {
    throw new Error("legacy application failure");
  }
}

export class LegacyObject extends WorkerEntrypoint {
  __alchemy_rpc_invoke__() {
    return undefined;
  }

  echo(value: string) {
    return value;
  }

  fail(): never {
    throw new Error("legacy application failure");
  }
}

export default { fetch: () => new Response("ready") };
