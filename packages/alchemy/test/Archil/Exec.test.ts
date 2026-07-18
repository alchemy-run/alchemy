import * as Archil from "@/Archil";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Archil.providers() });

const hasArchil = !!process.env.ARCHIL_API_KEY;

test.provider.skipIf(!hasArchil)(
  "exec, grep, and multi-disk exec against a deployed disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const disk = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("ExecDisk");
        }),
      );

      // Write-then-read on a real filesystem.
      const write = yield* Archil.execDisk({
        region: disk.region,
        diskId: disk.diskId,
        command:
          "echo alchemy-exec-marker > /mnt/archil/exec-test.txt && cat /mnt/archil/exec-test.txt",
      });
      expect(write.exitCode).toBe(0);
      expect(write.stdout.trim()).toBe("alchemy-exec-marker");
      expect(write.timing.executeMs).toBeGreaterThanOrEqual(0);

      // Non-zero exit codes are returned, not raised.
      const failing = yield* Archil.execDisk({
        region: disk.region,
        diskId: disk.diskId,
        command: "exit 3",
      });
      expect(failing.exitCode).toBe(3);

      // Default toolchain includes python3.
      const python = yield* Archil.execDisk({
        region: disk.region,
        diskId: disk.diskId,
        command: "python3 -c 'print(40 + 2)'",
      });
      expect(python.stdout.trim()).toBe("42");

      // Parallel grep sees the file written above (retry through listing
      // consistency).
      const grep = yield* Archil.grepDisk({
        region: disk.region,
        diskId: disk.diskId,
        directory: "",
        pattern: "alchemy-exec-marker",
        recursive: true,
      }).pipe(
        Effect.repeat({
          until: (r: Archil.GrepResult): boolean => r.matches.length > 0,
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
      expect(grep.matches.some((m) => m.file.includes("exec-test.txt"))).toBe(
        true,
      );

      // Multi-disk exec mounts the disk at a named relative path.
      const multi = yield* Archil.exec({
        region: disk.region,
        disks: { data: disk.diskId },
        command: "cat /mnt/archil/data/exec-test.txt",
      });
      expect(multi.exitCode).toBe(0);
      expect(multi.stdout.trim()).toBe("alchemy-exec-marker");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider.skipIf(!hasArchil)(
  "exec surfaces typed DiskNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* Archil.execDisk({
        region: "aws-us-east-1",
        diskId: "dsk-00000000000000ff",
        command: "true",
      }).pipe(
        Effect.map(() => "succeeded" as const),
        Effect.catchTag("DiskNotFound", () =>
          Effect.succeed("disk-not-found" as const),
        ),
      );
      expect(result).toBe("disk-not-found");
    }),
  { timeout: 60_000 },
);
