import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Layer from "effect/Layer";
import PiE2BApi from "./fixtures/workspaces/E2B.ts";
import { workspaceSuite } from "./workspaceSuite.ts";

workspaceSuite({
  platform: "e2b",
  providers: Layer.mergeAll(Cloudflare.providers(), E2B.providers()),
  api: PiE2BApi,
});
