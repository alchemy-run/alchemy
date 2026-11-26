/** Every implementation the gateways suite deploys. */
import * as Layer from "effect/Layer";
import EdgeLive from "./edge-live.ts";
import PrivateLive from "./private-live.ts";
import SecureLive from "./secure-live.ts";

export const Lives = Layer.mergeAll(PrivateLive, EdgeLive, SecureLive);
