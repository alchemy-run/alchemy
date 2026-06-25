import * as Layer from "effect/Layer";
import { makeTunnelClient } from "./TunnelBinding.ts";
import { readWriteClient, TunnelReadWrite } from "./TunnelReadWrite.ts";

/** Runtime layer for {@link TunnelReadWrite}. */
export const TunnelReadWriteBinding = Layer.effect(
  TunnelReadWrite,
  makeTunnelClient(
    "Cloudflare.TunnelReadWrite",
    ["Cloudflare Tunnel Read", "Cloudflare Tunnel Write"],
    readWriteClient,
  ),
);
