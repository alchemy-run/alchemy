import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
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
    Credentials.fromChain().pipe(
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(Endpoint.fromEnv()),
    ),
    "Task",
  );
