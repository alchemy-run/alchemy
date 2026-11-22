import * as archil from "@distilled.cloud/archil";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface BranchProps {
  /** Id of the disk to branch (e.g. `disk.diskId`). Changing it replaces the branch. */
  disk: string;
  /**
   * Branch name, unique within the disk. If omitted, a unique name is
   * generated from the stack, stage, and logical ID. Changing it replaces
   * the branch.
   */
  name?: string;
  /**
   * Name of the committed checkpoint the branch starts from (e.g.
   * `checkpoint.name`). Changing it replaces the branch.
   */
  fromCheckpoint: string;
  /**
   * Branch the checkpoint was taken on. Omit for a checkpoint on the root
   * disk. Changing it replaces the branch.
   */
  fromBranch?: string;
}

export interface BranchAttributes {
  /** Id of the disk the branch belongs to. */
  diskId: string;
  /** Branch name. Mount it with `archil mount <disk> <path> --branch <name>`. */
  name: string;
  /** Id of the branch's own writable filesystem. */
  filesystemId: string;
  /** Checkpoint the branch started from. */
  fromCheckpoint: string;
  /** Filesystem the checkpoint was taken on. */
  fromFilesystemId: string;
  /** When the branch was created. */
  createdAt: string;
}

export type Branch = Resource<
  "Archil.Branch",
  BranchProps,
  BranchAttributes,
  never,
  Providers,
  BranchLookup
>;

/**
 * Props for {@link Branch.lookup}: find a branch this stack
 * doesn't manage by its disk and name.
 */
export interface BranchLookup {
  /** Id of the disk the branch belongs to. */
  disk: string;
  /** Branch name. */
  name: string;
}

/**
 * An independent, writable fork of a disk, started from a committed
 * checkpoint in about 35 ms whatever the disk's size. Writes on the branch
 * never reach its source or its siblings. Branches share the disk's
 * credentials, so a disk user can mount any branch of its disk.
 *
 * Archil has no API to delete a branch yet, so destroying the resource
 * only removes it from Alchemy's state. Branches made per session at run
 * time come from {@link BranchDisk}.
 * @see https://docs.archil.com/concepts/branches-and-checkpoints
 *
 * ### Creating a Branch
 * **Example:** A staging copy of a seeded disk
 * ```typescript
 * export const Staging = Effect.gen(function* () {
 *   const seed = yield* Seed;
 *   const base = yield* Base;
 *   return yield* Archil.Branch("Staging", {
 *     disk: seed.diskId,
 *     fromCheckpoint: base.name,
 *   });
 * });
 * ```
 *
 * ### Looking up an existing branch
 * `Branch.lookup` references a branch Alchemy doesn't manage (created in
 * the Archil console or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Reference an existing branch
 * ```typescript
 * const main = Archil.Branch.lookup({ disk: "dsk_123", name: "main" });
 * ```
 *
 * @resource
 * @product Disk
 */
export const Branch = Resource<Branch>("Archil.Branch");

/** Map a branch response to attributes. */
export const toBranchAttributes = (branch: archil.BranchResponse): BranchAttributes => ({
  diskId: branch.root_filesystem_id,
  name: branch.branch_name,
  filesystemId: branch.filesystem_id,
  fromCheckpoint: branch.from_checkpoint_name,
  fromFilesystemId: branch.from_checkpoint_filesystem_id,
  createdAt: branch.created_at,
});

/** Get a branch; `undefined` when it (or its disk) doesn't exist. */
export const getBranch = (diskId: string, name: string) =>
  archil.getBranch({ id: diskId, name }).pipe(
    Effect.map(({ data }) => toBranchAttributes(data)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Create a branch, or return the existing one with that name. */
export const ensureBranch = Effect.fn(function* (input: {
  disk: string;
  name: string;
  fromCheckpoint: string;
  fromBranch?: string;
}) {
  const existing = yield* getBranch(input.disk, input.name);
  if (existing) return existing;
  return yield* archil
    .createBranch({
      id: input.disk,
      branch_name: input.name,
      from_checkpoint_name: input.fromCheckpoint,
      from_branch: input.fromBranch,
    })
    .pipe(
      Effect.map(({ data }) => toBranchAttributes(data)),
      // A concurrent create of the same name won the race.
      Effect.catchTag("Conflict", (conflict) =>
        getBranch(input.disk, input.name).pipe(
          Effect.flatMap((found) => (found ? Effect.succeed(found) : Effect.fail(conflict))),
        ),
      ),
    );
});

const branchName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 63, delimiter: "-" });

export const BranchProvider = () =>
  Provider.effect(
    Branch,
    Effect.gen(function* () {
      return {
        stables: [
          "diskId",
          "name",
          "filesystemId",
          "fromCheckpoint",
          "fromFilesystemId",
          "createdAt",
        ],
        // No delete API: nuke can't remove branches (they go with their disk).
        nuke: { skip: true },
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          const name = output?.name ?? (yield* branchName(id, olds.name));
          if (
            news.disk !== olds.disk ||
            (news.name !== undefined && news.name !== name) ||
            news.fromCheckpoint !== olds.fromCheckpoint ||
            news.fromBranch !== olds.fromBranch
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        lookup: ({ disk, name }) => getBranch(disk, name),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (!output && !olds) return undefined;
          const diskId = output?.diskId ?? olds!.disk;
          const name = output?.name ?? (yield* branchName(id, olds?.name));
          return yield* getBranch(diskId, name);
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          return yield* ensureBranch({
            disk: news.disk,
            name: output?.name ?? (yield* branchName(id, news.name)),
            fromCheckpoint: news.fromCheckpoint,
            fromBranch: news.fromBranch,
          });
        }),
        // Archil has no branch delete API; the branch goes with its disk.
        delete: () => Effect.void,
      };
    }),
  );
