import * as Archil from "@/Archil/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { WorkerDisk } from "./disks.ts";

/**
 * One Durable Object instance per user/thread, each owning its own Archil
 * disk — the DO holds identity and coordination, Archil holds the bytes.
 *
 * The deploy-time disk is the only thing bound; this instance's own disk is
 * derived from it at runtime, named after the DO instance. There is no
 * account-scoped handle in sight.
 */
export class Workspace extends Cloudflare.DurableObject<Workspace>()(
  "ArchilWorkspace",
  Effect.gen(function* () {
    // Init — binds the API token onto the host once per isolate.
    const root = yield* Archil.Connect(WorkerDisk);
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      // Per-instance — this workspace's disk, derived from the bound one.
      // `create` is idempotent, so this is get-or-create on every wake:
      // first touch provisions (milliseconds), later wakes just resolve.
      const name = `alchemy-ws-${state.id.name ?? state.id.toString()}`;
      const { disk } = yield* root.create(name).pipe(Effect.orDie);

      return {
        /** Run bash on this workspace's private filesystem. */
        run: (command: string) => disk.exec(command).pipe(Effect.orDie),
        /** Parallel search across this workspace. */
        search: (pattern: string) =>
          disk
            .grep({ directory: "", pattern, recursive: true })
            .pipe(Effect.orDie),
        /** Read from the shared deploy-time disk this one was derived from. */
        readTemplate: () =>
          root.exec("cat /mnt/archil/from-worker.txt").pipe(Effect.orDie),
        /** Tear the workspace down — idempotent. */
        destroy: () => disk.delete().pipe(Effect.orDie),
      };
    });
  }).pipe(Effect.provide(Archil.ConnectHttp)),
) {}
