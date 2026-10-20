import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Sandbox } from "./sandbox.ts";

/**
 * Drives the container's harnesses: the container serves each harness under
 * its own path. The container connection is made per call — never while the
 * DO is being constructed.
 */
export class Agent extends Cloudflare.DurableObject<Agent>()(
  "HarnessAgent",
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    return Effect.gen(function* () {
      const connect = (harness: string) =>
        sandbox.start({ enableInternet: true }).pipe(
          Effect.mapError((cause) => new AI.SessionError({ message: String(cause) })),
          Effect.andThen(sandbox.getTcpPort(3000)),
          Effect.flatMap((port) =>
            AI.connectHarness(Cloudflare.toHttpClient(port as never), {
              url: `http://sandbox/${harness}`,
            }),
          ),
        );
      return {
        /** Start (or resume) `sessionId` on `harness` and run one turn. */
        run: (harness: string, sessionId: string, prompt: string) =>
          Effect.gen(function* () {
            const session = yield* (yield* connect(harness)).start({ id: sessionId });
            const turn = yield* session.prompt(prompt);
            const result = yield* session.result(turn.turnId);
            return { info: yield* session.info(), result };
          }).pipe(Effect.scoped),
      };
    });
  }),
) {}
