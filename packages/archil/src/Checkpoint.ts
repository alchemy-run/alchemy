import * as archil from "@distilled.cloud/archil";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

/** A checkpoint's setup command exited non-zero. */
export class CheckpointSetupFailed extends Data.TaggedError("Archil.CheckpointSetupFailed")<{
  readonly checkpoint: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {}

export interface CheckpointProps {
  /** Id of the disk to checkpoint (e.g. `disk.diskId`). Changing it replaces the checkpoint. */
  disk: string;
  /**
   * Checkpoint name, unique within its branch. If omitted, a unique name
   * is generated from the stack, stage, and logical ID. Changing it
   * replaces the checkpoint.
   */
  name?: string;
  /**
   * Shell commands that seed the disk before the checkpoint is taken. They
   * run in a serverless microVM with the disk mounted at `/mnt/archil` (the
   * working directory). Changing them takes a new checkpoint.
   */
  run?: string[];
}

export interface CheckpointAttributes {
  /** Id of the disk. */
  diskId: string;
  /** Checkpoint name. Pass it to a {@link Branch} or `BranchDisk` as `fromCheckpoint`. */
  name: string;
}

export type Checkpoint = Resource<
  "Archil.Checkpoint",
  CheckpointProps,
  CheckpointAttributes,
  never,
  Providers
>;

/**
 * A named, point-in-time snapshot of a disk, the seeded base that branches
 * fork from. Alchemy runs the `run` commands against the disk, then takes
 * the checkpoint in the same microVM, so the checkpoint holds exactly what
 * they produced. A checkpoint takes about 15 ms whatever the disk's size,
 * and never changes after it's taken.
 *
 * Archil can't delete checkpoints yet, so destroying the resource only
 * removes it from Alchemy's state.
 * @see https://docs.archil.com/concepts/branches-and-checkpoints
 *
 * ### Seeding a Base
 * **Example:** Clone and install once, branch per session
 * ```typescript
 * export const Seed = Archil.Disk("Seed", {});
 * export const Base = Effect.gen(function* () {
 *   const seed = yield* Seed;
 *   return yield* Archil.Checkpoint("Base", {
 *     disk: seed.diskId,
 *     name: "base",
 *     run: [
 *       "git clone --depth 1 https://github.com/alchemy-run/alchemy repo",
 *       "cd repo && corepack enable && pnpm install --frozen-lockfile",
 *     ],
 *   });
 * });
 * ```
 *
 * @resource
 * @product Disk
 */
export const Checkpoint = Resource<Checkpoint>("Archil.Checkpoint");

const checkpointName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 63, delimiter: "-" });

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Seed a disk and take a checkpoint of it in one serverless exec. */
export const takeCheckpoint = Effect.fn(function* (
  diskId: string,
  name: string,
  run: ReadonlyArray<string>,
) {
  const script = [
    "set -e",
    "cd /mnt/archil",
    ...run.map((command) => `(${command})`),
    "sync",
    `archil checkpoints create /mnt/archil ${shellQuote(name)}`,
  ].join("\n");
  const { data } = yield* archil.execDisk({ id: diskId, command: script });
  if (data.exitCode !== 0) {
    return yield* new CheckpointSetupFailed({
      checkpoint: name,
      exitCode: data.exitCode,
      stderr: data.stderr,
    });
  }
  return { diskId, name } satisfies CheckpointAttributes;
});

export const CheckpointProvider = () =>
  Provider.effect(
    Checkpoint,
    Effect.gen(function* () {
      return {
        stables: ["diskId", "name"],
        // No list or delete API: checkpoints go with their disk.
        nuke: { skip: true },
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          const name = output?.name ?? (yield* checkpointName(id, olds.name));
          if (
            news.disk !== olds.disk ||
            (news.name !== undefined && news.name !== name) ||
            !deepEqual(news.run ?? [], olds.run ?? [])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        // Checkpoints have no read API; state is authoritative.
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (output && output.diskId === news.disk) return output;
          const name = yield* checkpointName(id, news.name);
          yield* session.note(`Seeding disk and taking checkpoint ${name}...`);
          return yield* takeCheckpoint(news.disk, name, news.run ?? []);
        }),
        // Archil has no checkpoint delete API.
        delete: () => Effect.void,
      };
    }),
  );
