import * as Alchemy from "alchemy";
import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Sandbox } from "./Sandbox.ts";

/**
 * Where a session's harness runs: under `alchemy dev`, the Sandbox's program
 * runs on this machine with a git worktree per session; deployed, every
 * session gets its own Sandbox container.
 */
const HarnessLive = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Alchemy.ALCHEMY_DEV)
      ? AI.LocalHarness(Sandbox)
      : Cloudflare.ContainerHarness(Sandbox, { enableInternet: true });
  }),
);

/**
 * One coding-agent session per Durable Object (the DO name is the session
 * id), serving the standard `AI.SessionRpcs` contract over the harness.
 */
export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  "Agent",
  { schema: AI.SessionRpcs },
  Effect.gen(function* () {
    const harness = yield* AI.Harness;
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() =>
      AI.makeSessionHandlers({ id: state.id.name ?? state.id.toString(), harness }),
    );
  }).pipe(Effect.provide(HarnessLive)),
) {}
