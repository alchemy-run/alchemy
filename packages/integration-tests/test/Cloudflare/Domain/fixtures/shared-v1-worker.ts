import * as Cloudflare from "@alchemy.run/cloudflare";
import { upgradeWorker } from "./upgrade.ts";

/** Billing and Audit at Domain version 1, neither keeping the data they shared. */
export default class DomainSharedV1Worker extends Cloudflare.Worker<DomainSharedV1Worker>()(
  "DomainSharedWorker",
  { main: import.meta.url },
  upgradeWorker({ version: 1, audit: true }),
) {}
