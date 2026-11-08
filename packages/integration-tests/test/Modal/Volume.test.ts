import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as volume from "@distilled.cloud/modal/volume";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Modal.providers() });

const named = (id: string) =>
  volume.volumeGetById({ volumeId: id }).pipe(
    Effect.map((response) => response.metadata?.name),
    Effect.catchTag("VolumeNotFound", () => Effect.succeed(undefined)),
  );

test.provider(
  "create, rename in place, and delete a volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Volume("Volume", {});
        }),
      );
      yield* expectFound(Modal.Volume.lookup({ name: created.name }), created);
      expect(created.version).toBe(2);
      expect(yield* named(created.volumeId)).toBe(created.name);

      const to = `${created.name.slice(0, 61)}-b`;
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Volume("Volume", { name: to });
        }),
      );
      expect(renamed.volumeId).toBe(created.volumeId);
      expect(yield* named(created.volumeId)).toBe(to);

      yield* stack.destroy();
      expect(yield* named(created.volumeId)).toBeUndefined();
    }),
  { tags: ["provider:modal", "provider:modal:volume", "live"], timeout: 120_000 },
);

test.provider(
  "changing the filesystem version replaces the volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Volume("Versioned", {});
        }),
      );
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Volume("Versioned", { version: 1 });
        }),
      );
      expect(v1.volumeId).not.toBe(v2.volumeId);
      expect(v1.version).toBe(1);
      expect(yield* named(v2.volumeId)).toBeUndefined();
      yield* stack.destroy();
      expect(yield* named(v1.volumeId)).toBeUndefined();
    }),
  { tags: ["provider:modal", "provider:modal:volume", "live"], timeout: 120_000 },
);
