import * as Layer from "effect/Layer";
import { makeTunnelClient } from "./TunnelBinding.ts";
import { readClient, TunnelRead } from "./TunnelRead.ts";

/** Runtime layer for {@link TunnelRead}. */
export const TunnelReadBinding = Layer.effect(
  TunnelRead,
  makeTunnelClient(
    "Cloudflare.TunnelRead",
    ["Cloudflare Tunnel Read"],
    readClient,
  ),
);
