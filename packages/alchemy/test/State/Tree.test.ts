import { describe, expect, it } from "@alchemy.run/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { inMemoryState, InMemoryService } from "@/State/InMemoryState.ts";
import type { ResourceState } from "@/State/ResourceState.ts";
import { State, StateStoreError } from "@/State/State.ts";
import { deleteState, listState, readState } from "@/State/Tree.ts";

const resource = {
  resourceType: "test:resource",
  namespace: undefined,
  fqn: "resource",
  logicalId: "resource",
  instanceId: "instance-resource",
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: {},
  attr: { value: 1 },
} as ResourceState;

const state = () =>
  inMemoryState({ app: { dev: { resource } } }, { app: { dev: { url: "https://example.com" } } });

describe("State tree", { tags: ["unit", "local"] }, () => {
  it.effect("queries state as structured data", () =>
    Effect.gen(function* () {
      expect(yield* listState({})).toEqual(["app/"]);
      expect(yield* listState({ path: "app/dev", recursive: true })).toEqual([
        "app/dev/resource",
        "app/dev/output",
      ]);

      expect(yield* readState({ path: "app/dev/output" })).toEqual([
        {
          path: "app/dev/output",
          kind: "output",
          value: { url: "https://example.com" },
        },
      ]);
    }).pipe(Effect.provide(state())),
  );

  it.live("reads records concurrently, at most 32 at a time, in list order", () =>
    Effect.gen(function* () {
      const names = Array.from({ length: 80 }, (_, i) => `resource-${String(i).padStart(2, "0")}`);
      const records = Object.fromEntries(
        names.map((name) => [name, { ...resource, fqn: name, logicalId: name, attr: { name } }]),
      );
      const base = yield* InMemoryService(
        { app: { dev: records } },
        { app: { dev: { url: "https://example.com" } } },
      );
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const firstBatch = yield* Deferred.make<void>();
      const monitored = {
        ...base,
        get: (request: Parameters<typeof base.get>[0]) =>
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (n) => n + 1);
            yield* Ref.update(peak, (n) => Math.max(n, current));
            if (current === 32) yield* Deferred.succeed(firstBatch, undefined);
            yield* Deferred.await(firstBatch);
            return yield* base.get(request);
          }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1))),
      };

      const entries = yield* readState({ path: "app/dev", recursive: true }).pipe(
        Effect.provideService(State, Effect.succeed(monitored)),
        Effect.timeout("3 seconds"),
      );

      expect(yield* Ref.get(peak)).toBe(32);
      expect(yield* Ref.get(active)).toBe(0);
      expect(entries.map((entry) => entry.path)).toEqual([
        ...names.map((name) => `app/dev/${name}`),
        "app/dev/output",
      ]);
      expect(entries[0]?.value).toEqual(records[names[0]!]);
      expect(entries.at(-1)?.value).toEqual({ url: "https://example.com" });
    }),
  );

  it.effect("propagates a state store read failure", () =>
    Effect.gen(function* () {
      const base = yield* InMemoryService({ app: { dev: { resource } } });
      const error = new StateStoreError({ message: "read failed" });
      const failed = {
        ...base,
        get: () => Effect.fail(error),
      };
      const actual = yield* readState({ path: "app/dev", recursive: true }).pipe(
        Effect.provideService(State, Effect.succeed(failed)),
        Effect.flip,
      );

      expect(actual).toBe(error);
    }),
  );

  it.effect("deletes subtrees and reports what was removed", () =>
    Effect.gen(function* () {
      const deleted = yield* deleteState({ path: "app/dev", recursive: true });

      expect(deleted).toEqual({
        _tag: "StateDeleted",
        path: "app/dev",
        deleted: ["app/dev/resource", "app/dev/output"],
      });
      expect(yield* listState({ path: "app" })).toEqual([]);
    }).pipe(Effect.provide(state())),
  );
});
