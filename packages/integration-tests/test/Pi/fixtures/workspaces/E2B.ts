import * as AIE2B from "@alchemy.run/ai/E2B";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import { api, workspace } from "./workspace.ts";

export class PiE2BWorkspace extends Cloudflare.DurableObject<PiE2BWorkspace>()(
  "PiE2BWorkspace",
  workspace(AIE2B.Sandboxes(E2B.Template("PiE2BBase", { image: "node:22-bookworm" }))),
) {}

export default class PiE2BApi extends Cloudflare.Worker<PiE2BApi>()(
  "PiE2BApi",
  { main: import.meta.url },
  api(PiE2BWorkspace),
) {}
