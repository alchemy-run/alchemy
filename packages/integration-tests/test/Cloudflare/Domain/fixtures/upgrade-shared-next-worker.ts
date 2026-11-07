import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing at Domain version 1, from a new bundle: a later code change to the same Worker. */
export default class DomainUpgradeSharedNextWorker extends Cloudflare.Worker<DomainUpgradeSharedNextWorker>()(
  "DomainUpgradeWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 1, audit: false }),
) {}
