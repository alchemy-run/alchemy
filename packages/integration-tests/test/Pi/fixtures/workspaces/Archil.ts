import * as AIArchil from "@alchemy.run/ai/Archil";
import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { api, workspace } from "./workspace.ts";

export class PiArchilWorkspace extends Cloudflare.DurableObject<PiArchilWorkspace>()(
  "PiArchilWorkspace",
  workspace(AIArchil.Sandboxes(Archil.Image("PiArchilBase", { image: "node:22-bookworm" }))),
) {}

export default class PiArchilApi extends Cloudflare.Worker<PiArchilApi>()(
  "PiArchilApi",
  { main: import.meta.url },
  api(PiArchilWorkspace),
) {}
