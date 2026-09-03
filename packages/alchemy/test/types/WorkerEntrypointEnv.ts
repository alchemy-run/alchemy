import * as Cloudflare from "@/Cloudflare";
import { WorkerEntrypoint } from "cloudflare:workers";

// ── `Cloudflare.WorkerEntrypoint` env inference guards ─────────────────────
//
// The entrypoint name is a runtime string, so nothing links it to the target
// module's exports. The class is supplied as a type argument instead; without
// it the entry stays a bare `Fetcher` (fetch + connect only).

declare class Api extends WorkerEntrypoint<unknown, Record<string, unknown>> {
  greet(name: string): Promise<string>;
  /** Non-promise returns are promisified by the RPC stub type. */
  count(): number;
}

declare const target: Cloudflare.Worker;

export const Worker = Cloudflare.Worker("EntrypointEnvTypeProbe", {
  script: "export default {}",
  env: {
    API: Cloudflare.WorkerEntrypoint<typeof Api>(target, "Api"),
    UNTYPED: Cloudflare.WorkerEntrypoint(target, "Api"),
  },
});

type Env = Cloudflare.InferEnv<typeof Worker>;
declare const env: Env;

// The named entrypoint's RPC methods are typed.
export const _greeting: Promise<string> = env.API.greet("alice");
export const _count: Promise<number> = env.API.count();
// ...and it is still a service stub.
export const _fetched: Promise<Response> = env.API.fetch("https://example.com");

// Without the type argument the entry is a plain `Fetcher`.
export const _untyped: Promise<Response> = env.UNTYPED.fetch(
  "https://example.com",
);
// @ts-expect-error - no entrypoint type argument, so no RPC methods
env.UNTYPED.greet("alice");
