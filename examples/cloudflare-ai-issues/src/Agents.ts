import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Boat from "@alchemy.run/boat";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Layer from "effect/Layer";
import { BoardLive } from "./Board.ts";
import { Triage } from "./Board/Triage.process.ts";
import { ModelsLive, Smart } from "./Models.ts";
import { SandboxLive } from "./Sandbox.ts";
import { PostAnswerLive, SearchIssuesLive } from "./Tools.ts";
import { TriageLive } from "./Triage.ts";

/**
 * The harness that runs every session. To run them on OpenCode, provide
 * `OpenCode.HarnessLive`, `OpenCodeCloudflare.DurableObjectStorage` and
 * `OpenCode.CodingTools` here instead; nothing else changes.
 */
const HarnessLive = Layer.mergeAll(Pi.HarnessLive, Pi.CodingTools).pipe(
  Layer.provide(PiCloudflare.DurableObjectStorage),
);

/** Where Triage sessions run: one Durable Object per issue. */
export default class Agents extends AICloudflare.ProcessHost<Agents>()(
  "Agents",
  { processes: [Triage] },
  TriageLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        HarnessLive,
        AI.DefaultModel(Smart),
        SearchIssuesLive,
        PostAnswerLive,
        BoardLive,
      ),
    ),
    Layer.provide(Layer.mergeAll(ModelsLive, SandboxLive)),
    Layer.provide(Boat.CreateSandboxHttp),
  ),
) {}
