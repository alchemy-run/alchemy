import * as Cloudflare from "@/Cloudflare";
import type * as Effect from "effect/Effect";

/**
 * The FUSE-mount container CLASS (Container Layer pattern: the runtime
 * half lives in `runtime.ts`). Its RPC surface is plain file physics
 * against the mountpoint — every operation proves the R2 bucket is
 * being served as a filesystem.
 */
export class FuseBox extends Cloudflare.Container<
  FuseBox,
  {
    /** The mountpoint the bucket is served at. */
    readonly mountPath: () => Effect.Effect<string>;
    /** Write a file under the mount (name is relative to the mountpoint). */
    readonly write: (
      name: string,
      content: string,
    ) => Effect.Effect<void, string>;
    /** Read a file under the mount. */
    readonly read: (name: string) => Effect.Effect<string, string>;
    /** List the mountpoint's entries. */
    readonly list: () => Effect.Effect<ReadonlyArray<string>, string>;
  }
>()("FuseBox") {}
