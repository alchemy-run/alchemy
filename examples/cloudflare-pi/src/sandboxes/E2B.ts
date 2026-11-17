import * as AI from "@alchemy.run/ai";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sandboxName } from "./name.ts";

/** One E2B sandbox per conversation. E2B kills it ten minutes after its last use. */
export const E2BSandbox = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const base = yield* E2B.Template("E2BBase", { image: "node:22-bookworm" });
    const sandboxes = yield* E2B.CreateSandbox(base);
    // E2B finds sandboxes by metadata.
    const metadataOf = (key: AI.SandboxTarget) => ({ conversation: sandboxName(key) });
    const find = (key: AI.SandboxTarget) =>
      sandboxes.list({ metadata: metadataOf(key), state: ["running", "paused"] });

    return {
      open: Effect.fn(function* (target) {
        const [existing] = yield* find(target);
        return existing
          ? yield* sandboxes.connect(existing.sandboxID)
          : yield* sandboxes.create({ metadata: metadataOf(target), timeout: 600 });
      }),
      remove: Effect.fn(function* (key) {
        const found = yield* find(key);
        yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
      }),
    };
  }),
).pipe(Layer.provide(E2B.CreateSandboxHttp));
