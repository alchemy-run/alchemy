import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AlchemyContext from "../AlchemyContext.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import type { ExecStackOptionsEncoded } from "../Cli/commands/deploy.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import * as Lock from "./Lock.ts";
import * as RpcPaths from "./RpcPaths.ts";

export const layer = (main: string) =>
  Layer.provideMerge(
    Lock.LockLive,
    Layer.provideMerge(
      RpcPaths.layer(main),
      Layer.mergeAll(
        AlchemyContext.AlchemyContextLive,
        makeConfigProvider(),
        Layer.unwrap(
          Effect.promise(() => {
            if ("Bun" in globalThis) {
              return import("./RpcServerBun.ts").then((m) => m.RpcServerBun);
            } else {
              return import("./RpcServerNode.js").then((m) => m.RpcServerNode);
            }
          }),
        ),
      ),
    ),
  );

const makeConfigProvider = () => {
  let options: Partial<ExecStackOptionsEncoded>;
  try {
    options = JSON.parse(
      process.env.ALCHEMY_EXEC_OPTIONS!,
    ) as ExecStackOptionsEncoded;
  } catch {
    options = {};
  }
  const envFile = Option.fromUndefinedOr(options.envFile);
  return ConfigProvider.layer(
    loadConfigProvider(envFile).pipe(
      Effect.map((base) => withProfileOverride(base, options.profile)),
    ),
  );
};
