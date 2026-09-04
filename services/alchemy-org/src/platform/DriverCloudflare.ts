import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Layer from "effect/Layer";
import { Model } from "./Model.ts";
import { SessionIndexD1 } from "./SessionIndexD1.ts";

/**
 * The org's DRIVER ASSEMBLY on Cloudflare — every seam answered by a
 * Cloudflare primitive:
 *
 * - the loop     → `DriverCloudflare` (one Durable Object per session:
 *                  thread + inbox + observations in DO storage,
 *                  reminders and crash recovery on the DO alarm, live
 *                  views on hibernatable WebSockets — storage and
 *                  PersistentRef come WITH the placement)
 * - the model    → the same Anthropic layer as local (Config rides
 *                  the Worker secrets seam)
 * - the index    → D1 rows fed by the driver's Events (sessions
 *                  emit from their own DOs; the board lists from any
 *                  Worker instance)
 */
export const DriverCloudflare = Cloudflare.AI.DriverCloudflare.pipe(
  Layer.provideMerge(AI.SessionIndexStream),
  Layer.provideMerge(SessionIndexD1),
  Layer.provide(Model),
);
