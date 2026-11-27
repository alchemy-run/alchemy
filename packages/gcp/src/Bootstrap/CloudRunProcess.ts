import {
  bootstrap as run,
  type ContainerMode,
  type ContainerPlatformLayers,
} from "alchemy/Runtime/ContainerProcess";
import { fromMetadataServer } from "../MetadataCredentials.ts";

export const bootstrap = <E>(
  entrypoint: unknown,
  platform: ContainerPlatformLayers<E>,
  mode: ContainerMode,
) => {
  // Cloud Run injects PORT only into the ingress container.
  if (mode === "server" && process.env.ALCHEMY_HTTP_PORT && !process.env.PORT) {
    process.env.PORT = process.env.ALCHEMY_HTTP_PORT;
  }
  return run(
    entrypoint,
    platform,
    mode,
    fromMetadataServer(),
    mode === "server" ? "Cloud Run service" : "Cloud Run job",
  );
};
