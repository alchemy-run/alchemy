import * as AI from "@alchemy.run/ai";
import * as Boat from "@alchemy.run/boat";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Repo } from "./Repo.ts";

/**
 * One Boat sandbox per issue, started from a snapshot that already has the
 * repository cloned at `~/repo`.
 */
export const Sandbox = Layer.effect(
  AI.Sandboxes,
  Effect.gen(function* () {
    const repo = yield* Repo;
    const checkout = yield* Boat.Snapshot("Checkout", {
      run: [Output.interpolate`git clone ${repo.cloneUrl} ~/repo`],
    });
    const sandboxes = yield* Boat.CreateSandbox(checkout);
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
