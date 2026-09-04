import * as Cloudflare from "@/Cloudflare";
import type * as Effect from "effect/Effect";

/**
 * The dev-mode FUSE container CLASS — same shape as the live fixture's
 * `FuseBox`, distinct identity (see `local-storage.ts`).
 */
export class LocalFuseBox extends Cloudflare.Container<
  LocalFuseBox,
  {
    readonly mountPath: () => Effect.Effect<string>;
    readonly write: (
      name: string,
      content: string,
    ) => Effect.Effect<void, string>;
    readonly read: (name: string) => Effect.Effect<string, string>;
    readonly list: () => Effect.Effect<ReadonlyArray<string>, string>;
  }
>()("LocalFuseBox") {}
