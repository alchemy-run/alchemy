import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

/**
 * One coding-agent session per Durable Object (the DO name is the session
 * id), serving the standard `AI.SessionRpcs` contract over the Claude Code
 * harness in its own container. Connections to the container are made per
 * call, never while the DO is being constructed.
 */
export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  "Agent",
  { schema: AI.SessionRpcs },
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() =>
      AI.SessionHandlers({
        id: state.id.name ?? state.id.toString(),
        harness: sandbox
          .getTcpPort(3000)
          .pipe(Effect.flatMap((port) => AI.connectHarness(Cloudflare.toHttpClient(port)))),
      }),
    );
  }).pipe(Effect.provide(Cloudflare.Containers.layer(Sandbox, { enableInternet: true }))),
) {}
