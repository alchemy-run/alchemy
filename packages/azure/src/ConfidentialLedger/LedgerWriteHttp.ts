import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AzureBindings from "../AzureBindings.ts";
import { type LedgerCallables, makeLedgerAccessHttpBinding } from "./BindingHttp.ts";
import { LedgerWrite, type WriteLedgerClient } from "./LedgerWrite.ts";

/** Resolve the write operations with the host's credentials. */
export const resolveLedgerWriteOps = Effect.gen(function* () {
  const createLedgerEntry = yield* AzureBindings.withCredentials(data.CreateLedgerEntry);
  return { createLedgerEntry };
});

/** Build a {@link WriteLedgerClient} from the resolved write operations. */
export const makeWriteLedgerClient = (
  ops: Effect.Success<typeof resolveLedgerWriteOps>,
  { one }: LedgerCallables,
): WriteLedgerClient => ({
  createEntry: one(ops.createLedgerEntry),
});

/**
 * Implementation of {@link LedgerWrite} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Contributor** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.LedgerWrite
 */
export const LedgerWriteHttp = Layer.effect(
  LedgerWrite,
  makeLedgerAccessHttpBinding({
    tag: "Azure.ConfidentialLedger.LedgerWrite",
    role: "Contributor",
    resolve: resolveLedgerWriteOps,
    build: makeWriteLedgerClient,
  }),
);
