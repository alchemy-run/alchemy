import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing at Domain version 0, moved from `DomainUpgradeWorker` to a Worker of its own. */
export default class DomainTransferWorker extends Cloudflare.Worker<DomainTransferWorker>()(
  "DomainTransferWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 0, audit: false, transferredFrom: "DomainUpgradeWorker" }),
) {}
