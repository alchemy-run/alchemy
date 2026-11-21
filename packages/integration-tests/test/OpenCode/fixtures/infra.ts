import * as Cloudflare from "@alchemy.run/cloudflare";

export const Gateway = Cloudflare.AI.Gateway("OpenCodeGateway", { collectLogs: true });
