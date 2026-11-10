import * as Boat from "@alchemy.run/boat";
import * as Pi from "@alchemy.run/pi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RemoveSandbox, sandboxName, type SandboxKey } from "./RemoveSandbox.ts";

/** The sandbox client, bound to the snapshot every conversation's sandbox boots from. */
const Sandboxes = Effect.gen(function* () {
  const base = yield* Boat.Snapshot("BoatBase", { run: ["npm install --global pnpm"] });
  return yield* Boat.CreateSandbox(base);
});

/** Boat finds sandboxes by label. */
const labelsOf = (key: SandboxKey) => ({ conversation: sandboxName(key) });

/**
 * One Boat sandbox per conversation. Boat stops it after ten minutes and
 * keeps its disk, so the next tool call resumes it with its files.
 */
const SandboxLive = Layer.effect(
  Pi.Sandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return Effect.fn(function* (target) {
      const labels = labelsOf(target);
      const [existing] = yield* sandboxes.list({ labels });
      if (existing === undefined) {
        return yield* sandboxes.create({
          type: "small",
          noEnv: true,
          autoStop: "10 minutes",
          labels,
        });
      }
      const sandbox = yield* sandboxes.connect(existing.id);
      yield* sandbox.resume({ autoStop: "10 minutes" });
      return sandbox;
    });
  }),
);

const RemoveLive = Layer.effect(
  RemoveSandbox,
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    return Effect.fn(function* (key) {
      const found = yield* sandboxes.list({ labels: labelsOf(key) });
      yield* Effect.forEach(found, (sandbox) => sandboxes.delete(sandbox.id));
    });
  }),
);

export const BoatSandbox = Layer.mergeAll(SandboxLive, RemoveLive).pipe(
  Layer.provide(Boat.CreateSandboxHttp),
);
