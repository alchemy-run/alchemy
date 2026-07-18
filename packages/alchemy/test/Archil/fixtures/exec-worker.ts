import * as Archil from "@/Archil/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { WorkerDisk } from "./disk.ts";

/**
 * Worker fixture exercising the Archil bindings from the workerd runtime:
 * `/exec` writes + reads a file on the disk via `bash`, `/grep` searches for
 * the marker it wrote, `/multi` mounts the disk at a named path.
 */
export default class ArchilExecWorker extends Cloudflare.Worker<ArchilExecWorker>()(
  "ArchilExecWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const run = yield* Archil.Exec(WorkerDisk);
    const grep = yield* Archil.Grep(WorkerDisk);
    const runMulti = yield* Archil.MultiExec({ data: WorkerDisk });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/exec")) {
          const result = yield* run(
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
          const result = yield* runMulti(
            "cat /mnt/archil/data/from-worker.txt",
          ).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Archil.ExecHttp, Archil.GrepHttp, Archil.MultiExecHttp),
    ),
  ),
) {}
