import * as Archil from "@/Archil";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Archil.providers() });

const hasArchil = !!process.env.ARCHIL_API_KEY;

/**
 * Branch/checkpoint coverage.
 *
 * Checkpoints can only be *created* from a mounted disk (the control plane
 * exposes no create route — `POST /checkpoints` is 405), so a fresh disk has
 * none and `createBranch` has nothing to fork from. What this suite pins down
 * without a mount is the half that is reachable over HTTP: both list routes
 * decode, and forking from a checkpoint that does not exist fails in the
 * typed error channel rather than escaping as an untyped catch-all.
 *
 * The full bake-checkpoint-then-fork lifecycle needs a Linux box with the
 * disk FUSE-mounted; it is gated behind `ARCHIL_TEST_CHECKPOINT` with the
 * checkpoint name to fork from.
 */
test.provider.skipIf(!hasArchil)(
  "lists branches and checkpoints on a fresh disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const disk = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Archil.Disk("BranchDisk");
        }),
      );

      const checkpoints = yield* Archil.listCheckpoints({
        region: disk.region,
        diskId: disk.diskId,
      });
      expect(Array.isArray(checkpoints)).toBe(true);

      const branches = yield* Archil.listBranches({
        region: disk.region,
        diskId: disk.diskId,
      });
      expect(Array.isArray(branches)).toBe(true);

      // Forking from a checkpoint that was never taken must surface as a
      // typed failure, not a catch-all `ArchilApiError`.
      const result = yield* Effect.result(
        Archil.createBranch({
          region: disk.region,
          diskId: disk.diskId,
          branchName: "alchemy-test-branch",
          fromCheckpoint: "checkpoint-that-does-not-exist",
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).not.toBe("ArchilApiError");
      }

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasArchil || !process.env.ARCHIL_TEST_CHECKPOINT)(
  "forks a branch from a baked checkpoint",
  (stack) =>
    Effect.gen(function* () {
      const diskId = process.env.ARCHIL_TEST_DISK_ID!;
      const fromCheckpoint = process.env.ARCHIL_TEST_CHECKPOINT!;
      const region = (process.env.ARCHIL_TEST_REGION ??
        "aws-us-east-1") as Archil.ArchilRegion;

      const checkpoints = yield* Archil.listCheckpoints({ region, diskId });
      expect(
        checkpoints.some(
          (c) =>
            c.checkpointName === fromCheckpoint && c.status === "committed",
        ),
      ).toBe(true);

      // Branches cannot be deleted, so the name must be stable across runs
      // and the second run must observe the already-existing branch rather
      // than leaking a new one per run.
      const branchName = "alchemy-test-fork";
      const existing = yield* Archil.listBranches({ region, diskId });
      const branch =
        existing.find((b) => b.branchName === branchName) ??
        (yield* Archil.createBranch({
          region,
          diskId,
          branchName,
          fromCheckpoint,
        }));

      expect(branch.branchName).toBe(branchName);
      expect(branch.rootFilesystemId).toBe(diskId);
      expect(branch.filesystemId).not.toBe("");
      expect(branch.fromCheckpointName).toBe(fromCheckpoint);

      // The fork is visible in the disk's branch list.
      const after = yield* Archil.listBranches({ region, diskId });
      expect(after.some((b) => b.branchName === branchName)).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
