import * as Layer from "effect/Layer";
import { makeTunnelClient } from "./TunnelBinding.ts";
import { TunnelWrite, writeClient } from "./TunnelWrite.ts";

/** Runtime layer for {@link TunnelWrite}. */
export const TunnelWriteBinding = Layer.effect(
  TunnelWrite,
  makeTunnelClient(
    "Cloudflare.TunnelWrite",
    ["Cloudflare Tunnel Write"],
    writeClient,
  ),
);
