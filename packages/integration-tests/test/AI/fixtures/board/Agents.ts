import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Layer from "effect/Layer";
import { Fast, ModelsLive } from "../Processes.ts";
import { Board, IssueWorkLive } from "./Board.ts";
import { Triage } from "./Triage.process.ts";
import { TriageLive } from "./Triage.ts";

/** The board, hosted on Durable Objects. Its policy asks for the Triage process. */
export const BoardLive = Board.layer(IssueWorkLive).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/** Where Triage sessions run: one object per issue. */
export default class BoardAgents extends AICloudflare.ProcessHost<BoardAgents>()(
  "BoardAgents",
  { processes: [Triage] },
  TriageLive.pipe(
    Layer.provide(Layer.mergeAll(Pi.HarnessLive, AI.DefaultModel(Fast), BoardLive)),
    Layer.provide(Layer.mergeAll(PiCloudflare.DurableObjectStorage, ModelsLive)),
  ),
) {}
