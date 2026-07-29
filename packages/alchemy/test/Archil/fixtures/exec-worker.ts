import * as Archil from "@/Archil/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { WorkerDisk } from "./disks.ts";

/**
 * Worker fixture exercising the Archil {@link Archil.Client} binding from
 * the workerd runtime:
 *
 * - `/static` — exec on a module-scope `Archil.Disk` resource
 * - `/grep`   — read-only search for the marker `/static` wrote
 * - `/multi`  — multi-disk exec mounting the pinned disk at a named path
 * - `/dynamic` — the flagship: provision a disk at request time, run bash
 *   on it, and delete it again — no disk reference at deploy time.
 */
export default class ArchilExecWorker extends Cloudflare.Worker<ArchilExecWorker>()(
  "ArchilExecWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    // Disk-scoped capabilities: the module-scope resource is bound directly,
    // the same shape as `Cloudflare.R2.ReadBucket(TestBucket)`.
    const exec = yield* Archil.Exec(WorkerDisk);
    const grep = yield* Archil.Grep(WorkerDisk);
    // Account-scoped client for the dynamic half (disks with no resource).
    const archil = yield* Archil.Client();
    const data = yield* archil.disk(WorkerDisk);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/static")) {
          const result = yield* exec(
            "echo worker-was-here > /mnt/archil/from-worker.txt && cat /mnt/archil/from-worker.txt",
          ).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        if (request.url.startsWith("/grep")) {
          const result = yield* grep({
            directory: "",
            pattern: "worker-was-here",
            recursive: true,
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        if (request.url.startsWith("/multi")) {
          const result = yield* archil
            .exec({
              disks: { data },
              command: "cat /mnt/archil/data/from-worker.txt",
            })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        if (request.url.startsWith("/dynamic")) {
          // Provision → exec → destroy, all at request time. The name is
          // deterministic and the disk is deleted before responding, so
          // repeated calls are idempotent and leak-free.
          const result = yield* Effect.gen(function* () {
            const scratch = yield* archil.createDisk({
              name: "alchemy-archil-dynamic-test",
            });
            const out = yield* scratch.disk.exec(
              "echo dynamic-was-here > /mnt/archil/scratch.txt && cat /mnt/archil/scratch.txt",
            );
            yield* scratch.disk.delete();
            return { ...out, diskId: scratch.diskId };
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Archil.ClientHttp, Archil.ExecHttp, Archil.GrepHttp),
    ),
  ),
) {}
