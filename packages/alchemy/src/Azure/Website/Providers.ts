import * as Layer from "effect/Layer";
import { Build } from "../../Command/Build.ts";
import { Dev } from "../../Command/Dev.ts";
import * as Command from "../../Command/Providers.ts";
import { DockerLive } from "../../Docker/Docker.ts";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "../../Website/Server.ts";
import { SiteImage, SiteImageProvider } from "./SiteImage.ts";

export const resources = [Build, Dev, SiteImage, WebsiteServer];
export const layers = () =>
  Layer.mergeAll(
    SiteImageProvider().pipe(Layer.provide(DockerLive)),
    WebsiteServerProvider(),
    Command.providers(),
  );
