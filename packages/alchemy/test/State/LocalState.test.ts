import { makeLocalState } from "@/State/LocalState.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

const resource = (fqn: string, attr: Record<string, unknown>): ResourceState =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr,
  }) as ResourceState;

describe("makeLocalState", () => {
  it.effect("set persists again after deleteStack removes the stage dir", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const key = {
        stack: "local-state-created-cache-test",
        stage: "test",
        fqn: "resource-a",
      };

      yield* state.set({ ...key, value: resource(key.fqn, { round: 1 }) });
      expect(yield* state.get(key)).toMatchObject({ attr: { round: 1 } });

      yield* state.deleteStack({ stack: key.stack });
      expect(yield* state.get(key)).toBeUndefined();

      // Before the `created`-cache invalidation, this write skipped
      // makeDirectory, failed with NotFound, and silently no-op'd.
      yield* state.set({ ...key, value: resource(key.fqn, { round: 2 }) });
      expect(yield* state.get(key)).toMatchObject({ attr: { round: 2 } });

      yield* state.deleteStack({ stack: key.stack });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("set persists again after a stage-scoped deleteStack", () =>
    Effect.gen(function* () {
      const state = yield* makeLocalState();
      const key = {
        stack: "local-state-created-cache-test-stage",
        stage: "test",
        fqn: "resource-a",
      };

      yield* state.set({ ...key, value: resource(key.fqn, { round: 1 }) });
      yield* state.deleteStack({ stack: key.stack, stage: key.stage });
      expect(yield* state.get(key)).toBeUndefined();

      yield* state.set({ ...key, value: resource(key.fqn, { round: 2 }) });
      expect(yield* state.get(key)).toMatchObject({ attr: { round: 2 } });

      yield* state.deleteStack({ stack: key.stack });
    }).pipe(Effect.provide(PlatformServices)),
  );
});
