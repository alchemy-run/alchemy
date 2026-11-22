import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AzureBindings from "../AzureBindings.ts";
import { type LedgerCallables, makeLedgerAccessHttpBinding } from "./BindingHttp.ts";
import { LedgerRead, type ReadLedgerClient } from "./LedgerRead.ts";

/** Resolve the read operations with the host's credentials, one at a time. */
export const resolveLedgerReadOps = Effect.gen(function* () {
  const getLedgerEntry = yield* AzureBindings.withCredentials(data.GetLedgerEntry);
  const getCurrentLedgerEntry = yield* AzureBindings.withCredentials(data.GetCurrentLedgerEntry);
  const listLedgerEntries = yield* AzureBindings.withCredentials(data.ListLedgerEntries);
  const getReceipt = yield* AzureBindings.withCredentials(data.GetReceipt);
  const getTransactionStatus = yield* AzureBindings.withCredentials(data.GetTransactionStatus);
  const listCollections = yield* AzureBindings.withCredentials(data.ListCollections);
  const listTags = yield* AzureBindings.withCredentials(data.ListTags);
  return {
    getLedgerEntry,
    getCurrentLedgerEntry,
    listLedgerEntries,
    getReceipt,
    getTransactionStatus,
    listCollections,
    listTags,
  };
});

/** Build a {@link ReadLedgerClient} from the resolved read operations. */
export const makeReadLedgerClient = (
  ops: Effect.Success<typeof resolveLedgerReadOps>,
  { one, all }: LedgerCallables,
): ReadLedgerClient => ({
  getEntry: one(ops.getLedgerEntry),
  getCurrentEntry: one(ops.getCurrentLedgerEntry),
  listEntries: one(ops.listLedgerEntries),
  getReceipt: one(ops.getReceipt),
  getTransactionStatus: one(ops.getTransactionStatus),
  listCollections: all(ops.listCollections),
  listTags: all(ops.listTags),
});

/**
 * Implementation of {@link LedgerRead} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Reader** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.LedgerRead
 */
export const LedgerReadHttp = Layer.effect(
  LedgerRead,
  makeLedgerAccessHttpBinding({
    tag: "Azure.ConfidentialLedger.LedgerRead",
    role: "Reader",
    resolve: resolveLedgerReadOps,
    build: makeReadLedgerClient,
  }),
);
