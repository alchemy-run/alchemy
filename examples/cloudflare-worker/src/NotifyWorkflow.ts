import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Room from "./Room.ts";

export default class NotifyWorkflow extends Cloudflare.Workflow<NotifyWorkflow>()(
  "Notifier",
  Effect.gen(function* () {
    const rooms = yield* Room;

    return Effect.gen(function* () {
      // Regression guard for https://github.com/alchemy-run/alchemy-effect/pull/71
      //
      // Accessing `Cloudflare.WorkerEnvironment` inside the workflow body
      // previously crashed with `Service not found: Cloudflare.Workers.WorkerEnvironment`
      // because `provideService(WorkerEnvironment, env)` was applied to the
      // outer `Effect.succeed(body)` wrapper (a no-op) instead of `body`
      // itself in `Workflow.ts`. Keeping this yield + the KV roundtrip below
      // ensures the integ test catches any future regression of that fix.
      const env = yield* Cloudflare.WorkerEnvironment;
      const event = yield* Cloudflare.WorkflowEvent;
      const { roomId, message } = event.payload as {
        roomId: string;
        message: string;
      };

      // Exercise an env binding from inside a workflow step — the real-world
      // pattern users follow (`env.<binding>.put(...)` / `.get(...)` etc).
      const stored = yield* Cloudflare.task(
        "kv-roundtrip",
        Effect.tryPromise({
          try: async () => {
            const key = `workflow:smoke:${roomId}`;
            await env.KV.put(key, message);
            const got = await env.KV.get(key);
            if (got !== message) {
              throw new Error(
                `KV roundtrip mismatch: expected "${message}", got "${got ?? "null"}"`,
              );
            }
            return got;
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }).pipe(Effect.orDie),
      );

      const processed = yield* Cloudflare.task(
        "process",
        Effect.succeed({
          text: `Processed: ${stored}`,
          ts: Date.now(),
        }),
      );

      const room = rooms.getByName(roomId);
      yield* Cloudflare.task(
        "broadcast",
        room.broadcast(`[workflow] ${processed.text}`),
      );

      yield* Cloudflare.sleep("cooldown", "2 seconds");

      yield* Cloudflare.task(
        "finalize",
        room.broadcast(`[workflow] complete for ${roomId}`),
      );

      return processed;
    });
  }),
) {}
