import { Build } from "alchemy/Command/Build";
import { Dev } from "alchemy/Command/Dev";
import * as Command from "alchemy/Command/Providers";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "alchemy/Website/Server";
import * as Layer from "effect/Layer";
import { AppDeployment, AppDeploymentProvider } from "./AppDeployment.ts";
import { StaticWebsite, StaticWebsiteProvider } from "./StaticWebsite.ts";

export const resources = [Build, Dev, AppDeployment, StaticWebsite, WebsiteServer];
export const layers = () =>
  Layer.mergeAll(
    AppDeploymentProvider(),
    StaticWebsiteProvider(),
    WebsiteServerProvider(),
    Command.providers(),
  );
