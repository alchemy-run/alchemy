import * as Cloudflare from "@/Cloudflare";
import * as FUSE from "@/FUSE";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { FuseBox } from "./container.ts";
import { Persist } from "./storage.ts";

/**
 * The FUSE-mount container GUEST: mounts the {@link Persist} bucket at
 * `/persist` during init (deploy time this registers the token +
 * credential bindings; runtime it spawns tigrisfs and waits for the
 * mount), then serves plain file physics against the mountpoint.
 *
 * Note: NO `dockerfile` — the FUSE.MountTigrisfs binding contributes the
 * `fuse3` + `tigrisfs` install to the generated image itself.
 */
export default FuseBox.make(
  {
    main: import.meta.url,
    runtime: "bun",
  },
  Effect.gen(function* () {
    const mount = yield* FUSE.Mount(Persist, {
      path: "/persist",
    });
    const fs = yield* FileSystem.FileSystem;

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

const asString = (error: unknown) => String(error);
