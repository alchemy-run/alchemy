import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { Board, BoardHandlers } from "@board/domain/Board.model";
import * as Layer from "effect/Layer";
import { BoardTokenLive, SessionLive } from "./Session.ts";

/**
 * Everything the Worker serves: the Session middleware and the Board hosted
 * on Durable Objects. Swap `DomainCloudflare.layerDurableObjects()` for
 * `Domain.InMemory` and nothing else changes.
 */
export const BoardLive = SessionLive.pipe(
  Layer.provideMerge(BoardTokenLive),
  Layer.provideMerge(Board.layer(BoardHandlers)),
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);
