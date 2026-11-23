import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as OpenCode from "@alchemy.run/opencode";
import * as OpenCodeCloudflare from "@alchemy.run/opencode/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Layer from "effect/Layer";
import { Adder, Operator, ProcessesLive } from "./Processes.ts";

/** The processes on Pi. */
export class PiAgents extends AICloudflare.ProcessHost<PiAgents>()(
  "PiAgents",
  { processes: [Adder, Operator] },
  ProcessesLive.pipe(
    Layer.provide(Pi.HarnessLive),
    Layer.provide(PiCloudflare.DurableObjectStorage),
  ),
) {}

/** The same processes on OpenCode: only the harness and its storage differ. */
export class OpenCodeAgents extends AICloudflare.ProcessHost<OpenCodeAgents>()(
  "OpenCodeAgents",
  { processes: [Adder, Operator] },
  ProcessesLive.pipe(
    Layer.provide(OpenCode.HarnessLive),
    Layer.provide(OpenCodeCloudflare.DurableObjectStorage),
  ),
) {}
