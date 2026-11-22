import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Effect from "effect/Effect";

/**
 * Ledger data-plane plumbing shared by `LedgerRoleAssignment` and the ledger
 * bindings. NOT exported from `index.ts`.
 *
 * A ledger serves TLS with a certificate issued by its own network identity,
 * not a public CA, so a plain `fetch` fails with `unable to verify the first
 * certificate`. Every data-plane call runs over a Node `https` client that
 * trusts exactly the ledger's TLS certificate, read from the anonymous
 * identity service (`identity.confidential-ledger.core.azure.com`).
 */

/** `https://{ledger}.confidential-ledger.azure.com`. */
export const ledgerEndpointOf = (ledgerName: string) =>
  `https://${ledgerName}.confidential-ledger.azure.com`;

/**
 * Run `effect` (ledger data-plane calls) over an HTTPS client that trusts
 * only `ledgerTlsCertificate` (PEM). The client's agent lives for the call.
 */
export const overLedgerTls =
  (ledgerTlsCertificate: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(NodeHttpClient.layerNodeHttpOptions({ ca: ledgerTlsCertificate })));
