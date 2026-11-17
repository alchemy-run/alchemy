import * as Archil from "@alchemy.run/archil";
import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** The disk the ECS task mounts; its own, so no other suite holds a mount on it. */
export const EcsDisk = Archil.Disk("EcsMountDisk", {});

/** The file the task writes through the mount. */
export const ECS_MARKER_KEY = "ecs/mounted.txt";
export const ECS_MARKER_TEXT = "written through fuse on ecs";

/**
 * A one-shot EC2 task: mounts the disk with its own disk user, writes a
 * file, reads it back, and unmounts (flushing the write) before it exits.
 */
export default class MountTask extends AWS.ECS.Task<MountTask>()(
  "ArchilMountTask",
  {
    main: import.meta.url,
    requiresCompatibilities: ["EC2"],
    networkMode: "bridge",
    cpu: 512,
    memory: 1024,
  },
  Effect.gen(function* () {
    const disk = yield* Archil.MountDisk(EcsDisk, { path: "/mnt/archil" });
    const fs = yield* FileSystem.FileSystem;
    return {
      run: Effect.scoped(
        Effect.gen(function* () {
          const path = yield* disk.mount();
          yield* Effect.log(`mount: mounted at ${path}`);
          yield* fs.makeDirectory(`${path}/ecs`, { recursive: true });
          yield* fs.writeFileString(`${path}/${ECS_MARKER_KEY}`, ECS_MARKER_TEXT);
          const back = yield* fs.readFileString(`${path}/${ECS_MARKER_KEY}`);
          if (back !== ECS_MARKER_TEXT) {
            return yield* Effect.die(`read back ${JSON.stringify(back)}`);
          }
          yield* Effect.log("mount: wrote and read the marker");
        }),
      ).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Archil.MountDiskLive)),
) {}
