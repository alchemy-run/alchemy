import * as Boat from "@alchemy.run/boat";
import * as Clanka from "@alchemy.run/clanka";
import * as Cloudflare from "@alchemy.run/cloudflare";

export const Gateway = Cloudflare.AI.Gateway("ClankaGateway", { collectLogs: true });

/** The snapshot every conversation's sandbox boots from, with clanka already installed. */
export const Base = Boat.Snapshot("ClankaBase", { run: [Clanka.installCommand] });
