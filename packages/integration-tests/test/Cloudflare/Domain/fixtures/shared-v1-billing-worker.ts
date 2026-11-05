import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing and Audit at Domain version 1, Billing keeping the data they shared. */
export default class DomainSharedV1BillingWorker extends Cloudflare.Worker<DomainSharedV1BillingWorker>()(
  "DomainSharedWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 1, audit: true, legacyData: "Billing" }),
) {}
