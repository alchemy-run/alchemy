import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiAccess } from "./ArchilBindings.ts";
import { makeDiskDelegationsClient, makeExecDiskClient } from "./Clients.ts";
import type { Disk } from "./Disk.ts";
import { ExecDisk } from "./ExecDisk.ts";

/** {@link ExecDisk} over Archil's HTTP API, usable from any host. */
export const ExecDiskHttp = Layer.effect(
  ExecDisk,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (disk: Disk) {
      const authorize = yield* access();
      const diskId = yield* disk.diskId;
      return {
        ...makeExecDiskClient(diskId, authorize),
        ...makeDiskDelegationsClient(
          Effect.map(diskId, (id) => ({ disk: id })),
          authorize,
        ),
      };
    });
  }),
);
