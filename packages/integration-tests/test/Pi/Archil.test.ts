import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Layer from "effect/Layer";
import PiArchilApi from "./fixtures/workspaces/Archil.ts";
import { workspaceSuite } from "./workspaceSuite.ts";

workspaceSuite({
  platform: "archil",
  providers: Layer.mergeAll(Cloudflare.providers(), Archil.providers()),
  api: PiArchilApi,
});
