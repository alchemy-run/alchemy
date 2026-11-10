import * as E2B from "@alchemy.run/e2b";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RemoveSandbox, sandboxName, type SandboxKey } from "./RemoveSandbox.ts";

/** The sandbox client, bound to the template every conversation's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const base = yield* E2B.Template("E2BBase", { image: "node:22-bookworm" });
  return yield* E2B.CreateSandbox(base);
});

/** E2B finds sandboxes by metadata. */
const metadataOf = (key: SandboxKey) => ({ conversation: sandboxName(key) });

/** One E2B sandbox per conversation. E2B kills it ten minutes after its last use. */
const SandboxLive = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return Effect.fn(function* (target) {
      const metadata = metadataOf(target);
      const [existing] = yield* sandboxes.list({ metadata, state: ["running", "paused"] });
      return existing
        ? yield* sandboxes.connect(existing.sandboxID)
        : yield* sandboxes.create({ metadata, timeout: 600 });
    });
  }),
);

const RemoveLive = Layer.effect(
  RemoveSandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return Effect.fn(function* (key) {
      const found = yield* sandboxes.list({
        metadata: metadataOf(key),
        state: ["running", "paused"],
      });
      yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
    });
  }),
);

export const E2BSandbox = Layer.mergeAll(SandboxLive, RemoveLive).pipe(
  Layer.provide(E2B.CreateSandboxHttp),
);
