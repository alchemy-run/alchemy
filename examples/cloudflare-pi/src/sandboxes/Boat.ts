import * as AI from "@alchemy.run/ai";
import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Boat finds a sandbox by a label and stops it on `suspend`, keeping its
 * disk. Boat stops a sandbox left running for ten minutes.
 */
export const BoatSandbox = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const base = yield* Boat.Snapshot("BoatBase", { run: ["npm install --global pnpm"] });
    const sandboxes = yield* Boat.CreateSandbox(base);
    const find = (key: string) => sandboxes.list({ labels: { key } });

    return {
      open: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        if (existing === undefined) {
          return yield* sandboxes.create({
            type: "small",
            noEnv: true,
            autoStop: "10 minutes",
            labels: { key },
          });
        }
        const sandbox = yield* sandboxes.connect(existing.id);
        yield* sandbox.resume({ autoStop: "10 minutes" });
        return sandbox;
      }),
      suspend: Effect.fn(function* (key) {
        const [existing] = yield* find(key);
        if (existing === undefined) return;
        const sandbox = yield* sandboxes.connect(existing.id);
        yield* sandbox.stop();
      }),
      remove: Effect.fn(function* (key) {
        const found = yield* find(key);
        yield* Effect.forEach(found, (sandbox) => sandboxes.delete(sandbox.id));
      }),
    };
  }),
).pipe(Layer.provide(Boat.CreateSandboxHttp));
