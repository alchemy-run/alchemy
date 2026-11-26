import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import {
  bootstrap as run,
  type ContainerMode,
  type ContainerPlatformLayers,
} from "alchemy/Runtime/ContainerProcess";
import * as Layer from "effect/Layer";

export const bootstrap = <E>(
  entrypoint: unknown,
  platform: ContainerPlatformLayers<E>,
  mode: ContainerMode,
) =>
  run(
    entrypoint,
    platform,
    mode,
    Layer.mergeAll(Credentials.fromChain(), Region.fromEnv()),
    mode === "server" ? "EKS Deployment" : "EKS Job",
  );
