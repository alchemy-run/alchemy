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
  "commands provision the disk and re-run only when they change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const built = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("BuiltDisk", {
            commands: [
              "mkdir -p /mnt/archil/bin",
              "printf 'v1' > /mnt/archil/bin/version",
            ],
          });
        }),
      );
      expect(built.commandsHash).toBeDefined();

      // The commands actually ran against the filesystem.
      const v1 = yield* Archil.execDisk({
        region: built.region,
        diskId: built.diskId,
        command: "cat /mnt/archil/bin/version",
      });
      expect(v1.stdout.trim()).toBe("v1");

      // Unchanged commands are a no-op: same disk, same fingerprint.
      const same = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("BuiltDisk", {
            commands: [
              "mkdir -p /mnt/archil/bin",
              "printf 'v1' > /mnt/archil/bin/version",
            ],
          });
        }),
      );
      expect(same.diskId).toBe(built.diskId);
      expect(same.commandsHash).toBe(built.commandsHash);

      // Changing the commands re-provisions in place — an update, not a
      // replacement, so the disk keeps its identity.
      const rebuilt = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("BuiltDisk", {
            commands: [
              "mkdir -p /mnt/archil/bin",
              "printf 'v2' > /mnt/archil/bin/version",
            ],
          });
        }),
      );
      expect(rebuilt.diskId).toBe(built.diskId);
      expect(rebuilt.commandsHash).not.toBe(built.commandsHash);

      const v2 = yield* Archil.execDisk({
        region: rebuilt.region,
        diskId: rebuilt.diskId,
        command: "cat /mnt/archil/bin/version",
      });
      expect(v2.stdout.trim()).toBe("v2");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

test.provider.skipIf(!hasArchil)(
  "a failing command fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A non-zero exit is a *value* on the exec API, so the provider has to
      // translate it — otherwise a broken build would deploy green.
      const result = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            return yield* Archil.Disk("FailingBuildDisk", {
              commands: ["exit 7"],
            });
          }),
        ),
      );
      expect(result._tag).toBe("Failure");

      yield* stack.destroy();
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
