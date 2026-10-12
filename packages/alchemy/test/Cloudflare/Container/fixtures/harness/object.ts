import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Anthropic from "@/Anthropic/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { HarnessBox } from "./box.ts";

/** Runs turns in a session, and stops the container between them. */
export class HarnessObject extends Cloudflare.DurableObject<HarnessObject>()(
  "HarnessObject",
  Effect.gen(function* () {
    const model = yield* Anthropic.Egress(HarnessBox, {
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    });
    const harness = yield* Cloudflare.Containers.Harness(HarnessBox);
    return Effect.gen(function* () {
      return {
        /** Run one turn and return its reply. */
        turn: (sessionId: string, prompt: string) =>
          Effect.gen(function* () {
            const claude = yield* harness.start({ egress: [model], instance: "standard-1" });
            const session = yield* claude
              .get(sessionId)
              .pipe(Effect.catch(() => claude.start({ id: sessionId })));
            const { turnId } = yield* session.prompt(prompt);
            const result = yield* session.result(turnId);
            return result.message
              .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
              .join("");
          }),
        /** Snapshot and stop the container. */
        stop: () => harness.stop(),
        /** Completed turns recorded in this Durable Object. */
        completedTurns: (sessionId: string) =>
          harness.events(sessionId).pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.interruptWhen(Effect.sleep("5 seconds")),
            Stream.runCount,
          ),
      };
    });
  }),
) {}
