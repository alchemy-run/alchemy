import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing, laid out as Domain version 1: every object in one class. */
export default class DomainUpgradeSharedWorker extends Cloudflare.Worker<DomainUpgradeSharedWorker>()(
  "DomainUpgradeWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 1, audit: false }),
) {}
