import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Layer from "effect/Layer";
import PiModalApi from "./fixtures/workspaces/Modal.ts";
import { workspaceSuite } from "./workspaceSuite.ts";

workspaceSuite({
  platform: "modal",
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Modal.providers(),
    // The Worker acts with the deployer's Modal token, which works on every plan.
    Modal.DeployerHostIdentity,
  ),
  api: PiModalApi,
});
