import * as AIDaytona from "@alchemy.run/ai/Daytona";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Daytona from "@alchemy.run/daytona";
import { api, workspace } from "./workspace.ts";

export class PiDaytonaWorkspace extends Cloudflare.DurableObject<PiDaytonaWorkspace>()(
  "PiDaytonaWorkspace",
  workspace(
    AIDaytona.Sandboxes(
      Daytona.Snapshot("PiDaytonaBase", { image: "node:22-bookworm", cpu: 1, memory: 1, disk: 3 }),
    ),
  ),
) {}

export default class PiDaytonaApi extends Cloudflare.Worker<PiDaytonaApi>()(
  "PiDaytonaApi",
  { main: import.meta.url },
  api(PiDaytonaWorkspace),
) {}
