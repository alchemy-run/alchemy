import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLedgerAccessHttpBinding } from "./BindingHttp.ts";
import { makeReadLedgerClient, resolveLedgerReadOps } from "./LedgerReadHttp.ts";
import { LedgerReadWrite } from "./LedgerReadWrite.ts";
import { makeWriteLedgerClient, resolveLedgerWriteOps } from "./LedgerWriteHttp.ts";

/**
 * Implementation of {@link LedgerReadWrite} over the distilled
 * `confidentialledger-data` data plane. Gives the host the ledger role
 * **Contributor** on the ledger.
 *
 * @layer
 * @provides Azure.ConfidentialLedger.LedgerReadWrite
 */
export const LedgerReadWriteHttp = Layer.effect(
  LedgerReadWrite,
  makeLedgerAccessHttpBinding({
    tag: "Azure.ConfidentialLedger.LedgerReadWrite",
    role: "Contributor",
    resolve: Effect.gen(function* () {
      const read = yield* resolveLedgerReadOps;
      const write = yield* resolveLedgerWriteOps;
      return { read, write };
    }),
    build: (ops, callables) => ({
      ...makeReadLedgerClient(ops.read, callables),
      ...makeWriteLedgerClient(ops.write, callables),
    }),
  }),
);
