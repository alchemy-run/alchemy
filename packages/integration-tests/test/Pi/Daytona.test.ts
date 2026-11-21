import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import * as Layer from "effect/Layer";
import PiDaytonaApi from "./fixtures/workspaces/Daytona.ts";
import { workspaceSuite } from "./workspaceSuite.ts";

workspaceSuite({
  platform: "daytona",
  providers: Layer.mergeAll(Cloudflare.providers(), Daytona.providers()),
  api: PiDaytonaApi,
});
