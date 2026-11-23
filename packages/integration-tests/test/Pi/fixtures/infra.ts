import * as Cloudflare from "@alchemy.run/cloudflare";

export const Gateway = Cloudflare.AI.Gateway("PiGateway", { collectLogs: true });
export const Notes = Cloudflare.KV.Namespace("PiNotes", {});
