import * as archil from "@distilled.cloud/archil";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiAccess } from "./ArchilBindings.ts";
import type { ExecResult } from "./Clients.ts";

/** One disk in a multi-disk exec. */
export interface ExecDisksMount {
  /** Disk id (`dsk-…`). */
  disk: string;
  /** Mount this subdirectory of the disk instead of its root. */
  subdirectory?: string;
  /** Mount without write access. */
  readOnly?: boolean;
  /** Write without the disk's root delegation, so other writers can mount it too. */
  conditional?: boolean;
}

export interface ExecDisksClient {
  /**
   * Run a shell command in a fresh microVM with several disks mounted.
   * Keys are paths under `/mnt/archil`; values are disk ids or mounts.
   */
  exec(request: {
    readonly disks: Record<string, string | ExecDisksMount>;
    readonly command: string;
  }): Effect.Effect<ExecResult, archil.ExecError, RuntimeContext>;
}

/**
 * Run one serverless command against several disks at once, e.g. read a
 * shared dataset and write into a user's own disk in the same call. Disks
 * are named at run time, so it works with disks created per user.
 *
 * ### Running Across Disks
 * **Example:** Copy a dataset into a user's disk
 * ```typescript
 * const exec = yield* Archil.ExecDisks();
 * const result = yield* exec.exec({
 *   disks: {
 *     data: { disk: datasetId, readOnly: true },
 *     home: userDisk.diskId,
 *   },
 *   command: "cp -r /mnt/archil/data/samples /mnt/archil/home/",
 * });
 * ```
 *
 * @binding
 * @product Disk
 */
export interface ExecDisks extends Binding.Service<
  ExecDisks,
  "Archil.ExecDisks",
  () => Effect.Effect<ExecDisksClient>
> {}

export const ExecDisks = Binding.Service<ExecDisks>("Archil.ExecDisks");

/** {@link ExecDisks} over Archil's HTTP API, usable from any host. */
export const ExecDisksHttp = Layer.effect(
  ExecDisks,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* () {
      const authorize = yield* access();
      return {
        exec: (request) =>
          authorize(
            archil
              .exec({
                command: request.command,
                disks: Object.fromEntries(
                  Object.entries(request.disks).map(([path, mount]) => [
                    path,
                    typeof mount === "string"
                      ? mount
                      : {
                          disk: mount.disk,
                          subdirectory: mount.subdirectory,
                          readOnly: mount.readOnly,
                          conditional: mount.conditional,
                        },
                  ]),
                ),
              })
              .pipe(
                Effect.map(({ data }) => ({
                  exitCode: data.exitCode,
                  stdout: data.stdout,
                  stderr: data.stderr,
                  timing: data.timing,
                })),
              ),
          ),
      } satisfies ExecDisksClient;
    });
  }),
);
