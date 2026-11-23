import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Layer from "effect/Layer";
import { Board } from "./Board/Board.model.ts";
import { IssueWorkLive } from "./Board/IssueWork.policy.ts";

/**
 * The board on Durable Objects. Its policy asks for the Triage process, so
 * whoever hosts the board says where Triage sessions run.
 */
export const BoardLive = Board.layer(IssueWorkLive).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);
