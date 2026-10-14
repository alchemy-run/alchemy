import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Cloudflare from "@/Cloudflare";
import { EgressSandbox } from "./box.ts";
import { GatewayA, GatewayB, REPO_A, REPO_B } from "./gateways.ts";

export interface Shell {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Owns one sandbox, granted GitHub egress from two gateways that share its hosts by path. */
export class EgressSandboxObject extends Cloudflare.DurableObject<EgressSandboxObject>()(
  "EgressSandboxObject",
  Effect.gen(function* () {
    const sandbox = yield* EgressSandbox;
    const a = yield* GatewayA;
    const b = yield* GatewayB;
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const { fetch } = yield* sandbox.getTcpPort(3000);
      return {
        /**
         * Start with A's repository and B's (B without GraphQL: one host, two
         * gateways), and A's drip (a host of its own).
         */
        start: (ttlMillis: number) =>
          sandbox.start({
            size: "small",
            egress: [
              a.repo.narrow({ repository: REPO_A }),
              b.repo.narrow({ repository: REPO_B, graphql: false }),
              a.drip,
            ],
            ttl: ttlMillis,
          }),
        /** Narrow the running sandbox to A's egress: the GitHub hosts change, the drip's doesn't. */
        narrow: () =>
          sandbox.setEgress({ egress: [a.repo.narrow({ repository: REPO_A }), a.drip] }),
        /** Run a script in the sandbox, without starting it (or re-applying its egress). */
        sh: (script: string) =>
          fetch(
            HttpClientRequest.post("http://container/sh").pipe(HttpClientRequest.bodyText(script)),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((body) => body as unknown as Shell),
          ),
        running: () => sandbox.running,
        /** What's stored (diagnostics). */
        debug: () =>
          Effect.promise(() => state.raw.storage.get("alchemy:egress")).pipe(
            Effect.map((stored) => ({ now: Date.now(), stored })),
          ),
        /** Reset this object (a new instance, with nothing in memory); its container keeps running. */
        abort: () => state.abort("egress test: restart the Durable Object"),
        stop: () => sandbox.stop(),
      };
    });
  }),
) {}
