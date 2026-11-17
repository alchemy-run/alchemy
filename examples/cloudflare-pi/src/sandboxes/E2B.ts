import * as AI from "@alchemy.run/ai";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * E2B finds a sandbox by its metadata and pauses it on `suspend`, keeping
 * its memory and files. E2B kills a sandbox left running for ten minutes.
 */
export const E2BSandbox = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const base = yield* E2B.Template("E2BBase", { image: "node:22-bookworm" });
    const sandboxes = yield* E2B.CreateSandbox(base);
    const find = (key: string) =>
      sandboxes.list({ metadata: { key }, state: ["running", "paused"] });

    return {
      open: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        return existing
          ? yield* sandboxes.connect(existing.sandboxID, { timeout: 600 })
          : yield* sandboxes.create({ metadata: { key }, timeout: 600 });
      }),
      suspend: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        if (existing?.state !== "running") return;
        const sandbox = yield* sandboxes.connect(existing.sandboxID);
        yield* sandbox.pause();
      }),
      remove: Effect.fn(function* (key) {
        const found = yield* find(key);
        yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
      }),
    };
  }),
).pipe(Layer.provide(E2B.CreateSandboxHttp));
