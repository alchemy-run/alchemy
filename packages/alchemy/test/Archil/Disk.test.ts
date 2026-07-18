import * as Archil from "@/Archil";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Archil.providers() });

const hasArchil = !!process.env.ARCHIL_API_KEY;

test.provider.skipIf(!hasArchil)(
  "create, observe, re-deploy, and delete a disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const disk = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("TestDisk");
        }),
      );

      expect(disk.diskId).toMatch(/^dsk-[0-9a-f]{16}$/);
      expect(disk.status).toBe("available");
      expect(disk.endpoint).toContain("archil.com");
      expect(disk.region).toBe("aws-us-east-1");
      // The one-time mount token is captured at creation.
      expect(disk.diskToken).toBeDefined();
      expect(Redacted.value(disk.diskToken!).length).toBeGreaterThan(0);

      // Out-of-band observe via the raw API.
      const fetched = yield* Archil.getDisk({
        region: disk.region,
        diskId: disk.diskId,
      });
      expect(fetched.name).toBe(disk.name);

      // Provider list enumerates the deployed disk.
      const provider = yield* Provider.findProvider(Archil.Disk);
      const all = yield* provider.list();
      expect(all.find((d) => d.diskId === disk.diskId)).toBeDefined();

      // Idempotent re-deploy keeps identity and the captured token.
      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("TestDisk");
        }),
      );
      expect(again.diskId).toBe(disk.diskId);
      expect(again.diskToken).toBeDefined();

      yield* stack.destroy();

      // Typed wait-until-gone: the provider's delete already waits, so the
      // disk must be gone (or at worst still draining as `deleting`).
      const gone = yield* Archil.getDisk({
        region: disk.region,
        diskId: disk.diskId,
      }).pipe(
        Effect.map((d) => d.status === "deleting" || d.status === "deleted"),
        Effect.catchTag("DiskNotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasArchil)(
  "explicit name and region are honored",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const disk = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("NamedDisk", {
            name: "alchemy-test-named-disk",
            region: "aws-us-east-1",
          });
        }),
      );

      expect(disk.name).toBe("alchemy-test-named-disk");
      expect(disk.region).toBe("aws-us-east-1");

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
