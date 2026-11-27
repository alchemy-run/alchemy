import {
  bootstrap as run,
  type ContainerMode,
  type ContainerPlatformLayers,
} from "alchemy/Runtime/ContainerProcess";
import * as Layer from "effect/Layer";
import { fromChain } from "../Credentials.ts";
import { fromCredentials } from "../Environment.ts";

export const bootstrap = <E>(
  entrypoint: unknown,
  platform: ContainerPlatformLayers<E>,
  mode: ContainerMode,
) =>
  run(
    entrypoint,
    platform,
    mode,
    fromCredentials().pipe(Layer.provideMerge(fromChain())),
    mode === "server" ? "GKE Deployment" : "GKE Job",
  );
