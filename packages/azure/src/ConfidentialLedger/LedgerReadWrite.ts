import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Ledger } from "./Ledger.ts";
import type { ReadLedgerClient } from "./LedgerRead.ts";
import type { WriteLedgerClient } from "./LedgerWrite.ts";

/** Read and write client for one Confidential Ledger. */
export interface ReadWriteLedgerClient extends ReadLedgerClient, WriteLedgerClient {}

/**
 * Append and read entries, receipts and transaction states of an Azure
 * Confidential Ledger.
 *
 * Binding gives the host the ledger role **Contributor** (read and write
 * entries; the smallest ledger role that does both) with an
 * `Azure.ConfidentialLedger.LedgerRoleAssignment`. Ledger access is the
 * ledger's own user list, not Azure RBAC; the deploying identity must be a
 * ledger `Administrator`. The host calls the ledger over TLS that trusts the
 * ledger's own certificate, so it must run on a Node.js runtime (an Azure
 * Function, App Service, Container App, …), not a Cloudflare Worker.
 * Provide {@link LedgerReadWriteHttp}.
 *
 * ### Writing and Verifying
 * **Example:** Write an entry and wait until it is committed
 * ```typescript
 * // init
 * const audit = yield* Azure.ConfidentialLedger.LedgerReadWrite(ledger);
 *
 * // runtime
 * const { transactionId } = yield* audit.createEntry({ contents: "hello" });
 * const status = yield* audit.getTransactionStatus({ transactionId: transactionId! }).pipe(
 *   Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (s) => s.state === "Committed", times: 10 }),
 * );
 * ```
 *
 * @binding
 * @category ConfidentialLedger
 */
export interface LedgerReadWrite extends Binding.Service<
  LedgerReadWrite,
  "Azure.ConfidentialLedger.LedgerReadWrite",
  (ledger: Ledger) => Effect.Effect<ReadWriteLedgerClient>
> {}

export const LedgerReadWrite = Binding.Service<LedgerReadWrite>(
  "Azure.ConfidentialLedger.LedgerReadWrite",
);
