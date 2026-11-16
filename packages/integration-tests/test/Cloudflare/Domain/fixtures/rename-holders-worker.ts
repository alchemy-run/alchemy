import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** {@link DomainRenameWorker}'s next deploy, which adds the Holders view. */
export default class DomainRenameHoldersWorker extends Cloudflare.Worker<DomainRenameHoldersWorker>()(
  "DomainRenameWorker",
  { main: import.meta.url },
  upgradeWorker({
    version: 0,
    audit: false,
    transferredFrom: "DomainUpgradeWorker",
    formerModel: "Billing",
    ledger: "holders",
  }),
) {}
