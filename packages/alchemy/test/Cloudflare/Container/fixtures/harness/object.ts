import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Anthropic from "@/Anthropic/index.ts";
import * as Cloudflare from "@/Cloudflare";
import { HarnessBox } from "./box.ts";

/** Runs turns in a session; stops or crashes the container between them. */
export class HarnessObject extends Cloudflare.DurableObject<HarnessObject>()(
  "HarnessObject",
  Effect.gen(function* () {
    const model = yield* Anthropic.Egress(HarnessBox, {
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
    });
    const harness = yield* Cloudflare.Containers.Harness(HarnessBox, {
      workspace: "/workspace/repo",
    });
    const box = yield* HarnessBox;
    const state = yield* Cloudflare.DurableObjectState;
    const meta = (key: string) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM alchemy_harness_meta WHERE key = ?", key)
        .pipe(Effect.flatMap((cursor) => cursor.toArray()));
    const run = (script: string, ...args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* box.exec(["sh", "-c", script, "sh", ...args]);
          const output = yield* child.output();
          return new TextDecoder().decode(output.stdout);
        }),
      );
    return Effect.gen(function* () {
      return {
        /** Run one turn and return its reply. */
        turn: (sessionId: string, prompt: string) =>
          Effect.gen(function* () {
            const claude = yield* harness.start({ egress: [model], instance: "standard-1" });
            // The workspace is ours to set up — unless a checkpoint already
            // brought it back.
            yield* run(
              "[ -d /workspace/repo/.git ] || (cd /workspace/repo && git init -q -b main && echo base > base.txt && git add . && git -c user.name=t -c user.email=t@t commit -qm base)",
            );
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
        /**
         * Lose the container without a snapshot: wait for the last turn's
         * checkpoint, kill the container, and forget its snapshot.
         */
        crash: () =>
          Effect.gen(function* () {
            yield* meta("checkpoint").pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (rows) => rows.length > 0,
                times: 60,
              }),
            );
            // The checkpoint runs in the background; let it finish.
            yield* Effect.sleep("3 seconds");
            yield* box.destroy().pipe(Effect.ignore);
            yield* state.storage.sql.exec(
              "DELETE FROM alchemy_harness_meta WHERE key = 'snapshot'",
            );
          }),
        /**
         * A plain `exec` reaching the model API through the egress, over
         * intercepted TLS, right after the container starts.
         */
        probe: () =>
          Effect.gen(function* () {
            yield* box.destroy().pipe(Effect.ignore);
            yield* harness.start({ egress: [model], instance: "standard-1" });
            return yield* run(
              `node -e "fetch('https://api.anthropic.com/v1/models').then(() => console.log('ok'), (e) => console.log(String(e.cause ?? e)))"`,
            );
          }),
        /** A file in the running container ("" when it's missing). */
        read: (path: string) => run(`cat "$1" 2>/dev/null || true`, path),
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
