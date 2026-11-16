import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing's classes, moved from `DomainUpgradeWorker` to a Worker of their own as the Ledger model. */
export default class DomainRenameWorker extends Cloudflare.Worker<DomainRenameWorker>()(
  "DomainRenameWorker",
  { main: import.meta.url },
  upgradeWorker({
    version: 0,
    audit: false,
    transferredFrom: "DomainUpgradeWorker",
    formerModel: "Billing",
    ledger: "ledger",
  }),
) {}
