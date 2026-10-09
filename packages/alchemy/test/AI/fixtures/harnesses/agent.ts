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
    const start = sandbox
      .start({ enableInternet: true })
      .pipe(Effect.mapError((cause) => new AI.SessionError({ message: String(cause) })));
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.sync(() => {
      const name = state.id.name ?? state.id.toString();
      const harness = name.split(":")[0];
      return AI.makeSessionHandlers({
        id: name,
        harness: start.pipe(
          Effect.andThen(sandbox.getTcpPort(3000)),
          Effect.flatMap((port) =>
            // The port needs RuntimeContext, which the Durable Object provides.
            AI.connectHarness(Cloudflare.toHttpClient(port as never), {
              url: `http://sandbox/${harness}`,
            }),
          ),
        ),
      });
    });
  }),
) {}
