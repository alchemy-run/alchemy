import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { VolumeSandbox } from "./box.ts";
import { TestWorkspace } from "./workspace.ts";

/** Owns the sandbox and drives the volume's heads. */
export class VolumeObject extends Cloudflare.DurableObject<VolumeObject>()(
  "VolumeObject",
  Effect.gen(function* () {
    const sandbox = yield* VolumeSandbox;
    const disk = yield* TestWorkspace.on(VolumeSandbox);
    return Effect.gen(function* () {
      return {
        start: () => sandbox.start({ size: "small", enableInternet: true }),
        stop: () => sandbox.stop(),
        head: (name: string) => disk.head(name),
        fork: (to: string, from?: string) => disk.fork(to, from ? { from } : {}),
        exec: (head: string, command: string) => disk.exec(head, command),
        history: (head: string) => disk.history(head, { limit: 50 }),
        reset: (head: string, snapshot: string) => disk.reset(head, snapshot),
        drop: (head: string) => disk.drop(head),
      };
    });
  }),
) {}
