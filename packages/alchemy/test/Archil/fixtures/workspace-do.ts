import * as Archil from "@/Archil/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkerDisk } from "./disks.ts";

/**
 * One Durable Object instance per user/thread, each owning its own Archil
 * disk — the DO holds identity and coordination, Archil holds the bytes.
 *
 * Both binding shapes appear here:
 *
 * - `Archil.Exec(WorkerDisk)` — a disk known at deploy time, bound once.
 *   Every instance shares it (the read-only template).
 * - `Archil.Client()` — the account-scoped client, used to materialize this
 *   instance's *own* disk at runtime. There is no resource for it: the disk
 *   is named after the DO instance and exists only because someone
 *   addressed that name.
 */
export class Workspace extends Cloudflare.DurableObject<Workspace>()(
  "ArchilWorkspace",
  Effect.gen(function* () {
    // Init — binds the API token onto the host once per isolate.
    const archil = yield* Archil.Client();
    const template = yield* Archil.Exec(WorkerDisk);
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      // Per-instance — this workspace's disk, named after the DO instance.
      // `createDisk` is idempotent, so this is get-or-create on every wake:
      // first touch provisions (milliseconds), later wakes just resolve.
      const name = `alchemy-ws-${state.id.name ?? state.id.toString()}`;
      const { disk } = yield* archil.createDisk({ name }).pipe(Effect.orDie);

      return {
        /** Run bash on this workspace's private filesystem. */
        run: (command: string) => disk.exec(command).pipe(Effect.orDie),
        /** Parallel search across this workspace. */
        search: (pattern: string) =>
          disk
            .grep({ directory: "", pattern, recursive: true })
            .pipe(Effect.orDie),
        /** Read from the shared template disk bound at deploy time. */
        readTemplate: () =>
          template("cat /mnt/archil/from-worker.txt").pipe(Effect.orDie),
        /** Tear the workspace down — idempotent. */
        destroy: () => disk.delete().pipe(Effect.orDie),
      };
    });
  }).pipe(Effect.provide(Layer.mergeAll(Archil.ClientHttp, Archil.ExecHttp))),
) {}
