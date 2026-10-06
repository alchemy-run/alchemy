import * as Effect from "effect/Effect";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { AgentSandbox } from "./sandbox.ts";

/**
 * One coding-agent session per Durable Object: the DO name is the session
 * id, and the standard `AI.SessionRpcs` contract is served by mapping onto
 * the harness running in its container. The container connection is made
 * per call — never while the DO is being constructed.
 */
export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  "Agent",
  { schema: AI.SessionRpcs },
  Effect.gen(function* () {
    const sandbox = yield* AgentSandbox;
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() =>
      AI.SessionHandlers({
        id: state.id.name ?? state.id.toString(),
        harness: sandbox
          .getTcpPort(3000)
          .pipe(Effect.flatMap((port) => AI.connectHarness(Cloudflare.toHttpClient(port)))),
      }),
    );
  }).pipe(Effect.provide(Cloudflare.Containers.layer(AgentSandbox, { enableInternet: true }))),
) {}
