import { DockerLive } from "@alchemy.run/docker/Docker";
import { Build } from "alchemy/Command/Build";
import { Dev } from "alchemy/Command/Dev";
import * as Command from "alchemy/Command/Providers";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "alchemy/Website/Server";
import * as Layer from "effect/Layer";
import { SiteImage, SiteImageProvider } from "./SiteImage.ts";

export const resources = [Build, Dev, SiteImage, WebsiteServer];
export const layers = () =>
  Layer.mergeAll(
    SiteImageProvider().pipe(Layer.provide(DockerLive)),
    WebsiteServerProvider(),
    Command.providers(),
  );
