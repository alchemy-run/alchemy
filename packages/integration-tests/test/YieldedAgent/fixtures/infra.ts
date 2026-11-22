import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";

export const Gateway = Cloudflare.AI.Gateway("YieldedGateway", { collectLogs: true });

/** The snapshot every Thread's sandbox boots from. */
export const Base = Boat.Snapshot("YieldedBase", { run: ["node --version"] });
