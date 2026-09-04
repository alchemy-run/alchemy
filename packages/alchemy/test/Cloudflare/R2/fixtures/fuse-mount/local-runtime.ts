import * as Cloudflare from "@/Cloudflare";
import * as FUSE from "@/FUSE";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LocalFuseBox } from "./local-container.ts";
import { LocalFusePersist } from "./local-storage.ts";

/**
 * The dev-mode FUSE container GUEST. Under `alchemy dev` the FuseMount
 * plan binds the FUSE marker instead of minting a token; the local
 * Docker interceptor grants the device/capability and injects the dev
 * S3 gateway's URL; and at runtime tigrisfs mounts the LOCAL simulator
 * bucket — same code as live, different substrate.
 *
 * NO `dockerfile`, and the dev image builds for the HOST architecture:
 * the FUSE.MountTigrisfs binding contributes an arch-parameterized
 * `fuse3` + `tigrisfs` install to the generated image.
 */
export default LocalFuseBox.make(
  {
    main: import.meta.url,
    runtime: "bun",
  },
  Effect.gen(function* () {
    const mount = yield* FUSE.Mount(LocalFusePersist, {
      path: "/persist",
    });
    const fs = yield* FileSystem.FileSystem;
    const asString = (error: unknown) => String(error);

    return {
      mountPath: () => Effect.succeed(mount.path),
      write: (name: string, content: string) =>
        fs
          .writeFileString(`${mount.path}/${name}`, content)
          .pipe(Effect.mapError(asString)),
      read: (name: string) =>
        fs
          .readFileString(`${mount.path}/${name}`)
          .pipe(Effect.mapError(asString)),
      list: () => fs.readDirectory(mount.path).pipe(Effect.mapError(asString)),
      // the RPC surface is the product; fetch only answers health checks
      fetch: HttpServerResponse.json({ ok: true }),
    };
  }).pipe(Effect.provide(FUSE.MountTigrisfs)),
);
