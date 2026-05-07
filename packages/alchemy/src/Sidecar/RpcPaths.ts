import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { fileURLToPath } from "node:url";
import * as AlchemyContext from "../AlchemyContext.ts";

export class RpcPaths extends Context.Service<
  RpcPaths,
  { readonly lock: string; readonly url: string }
>()("RpcPaths") {}

export const layer = (main: string) =>
  Layer.effect(
    RpcPaths,
    Effect.gen(function* () {
      const { dotAlchemy } = yield* AlchemyContext.AlchemyContext;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const id = Math.abs(Hash.string(sanitizeSidecarMain(main)));
      const dir = path.resolve(dotAlchemy, "local");
      yield* fs.makeDirectory(dir, { recursive: true });
      return RpcPaths.of({
        lock: path.join(dir, `${id}.lock`),
        url: path.join(dir, `${id}.url`),
      });
    }),
  );

/**
 * The sidecar main file is provided using `import.meta.resolve("./SidecarServer.ts", import.meta.url)`.
 * This changes the extension to .js if you're currently running in js.
 */
export const sanitizeSidecarMain = (url: string) => {
  const main = fileURLToPath(url);
  return import.meta.url.endsWith(".js") ? main.replace(".ts", ".js") : main;
};
