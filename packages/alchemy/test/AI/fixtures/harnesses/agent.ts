import * as Effect from "effect/Effect";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { Sandbox } from "./sandbox.ts";

/**
 * One session per Durable Object, and so one container per session. The DO
 * name is `<harness>:<session>`; the harness picks the path the container
 * serves it under. The container connection is made per call — never while
 * the DO is being constructed.
 */
export class Agent extends Cloudflare.RpcDurableObject<Agent>()(
  "HarnessAgent",
  { schema: AI.SessionRpcs },
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() => {
      const name = state.id.name ?? state.id.toString();
      const harness = name.split(":")[0];
      return AI.makeSessionHandlers({
        id: name,
        harness: sandbox.getTcpPort(3000).pipe(
          Effect.flatMap((port) =>
            AI.connectHarness(Cloudflare.toHttpClient(port), {
              url: `http://sandbox/${harness}`,
            }),
          ),
        ),
      });
    });
  }).pipe(Effect.provide(Cloudflare.Containers.layer(Sandbox, { enableInternet: true }))),
) {}
