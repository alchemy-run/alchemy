import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";

export const Gateway = Cloudflare.AI.Gateway("PiGateway", { collectLogs: true });
export const Notes = Cloudflare.KV.Namespace("PiNotes", {});
export const Base = E2B.Template("PiBase", { image: "node:22-bookworm" });
