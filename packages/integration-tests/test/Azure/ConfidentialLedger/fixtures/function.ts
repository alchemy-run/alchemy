import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/** Collection every route writes to and reads from. */
export const COLLECTION = "bindings";
/** Tag on the entries `/write` creates. */
export const TAG = "alchemy";

/**
 * The ledger's administrator. The test sets it to the deployer's object ID
 * before deploying, so it can verify each binding through the data plane.
 */
export const ledgerAdmin = { objectId: "" };

// Confidential Ledger rejects resource group names over 63 characters.
export const LedgerGroup = Azure.Resources.ResourceGroup("LedgerBindingsGroup", {
  name: "alchemy-test-cl-bindings",
  location: "eastus",
});

/** The bound ledger. Its props are read when it is deployed. */
export const BindingsLedger = Effect.gen(function* () {
  const group = yield* LedgerGroup;
  return yield* Azure.ConfidentialLedger.Ledger(
    "BindingsLedger",
    Effect.sync(() => ({
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      aadBasedSecurityPrincipals: [
        { principalId: ledgerAdmin.objectId, ledgerRoleName: "Administrator" as const },
      ],
    })),
  );
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/**
 * Effect-native Azure Function exercising every Confidential Ledger
 * binding on a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and ledger-user propagation, and a real failure shows the
 * ledger error.
 */
export default class LedgerFunction extends Azure.Functions.Function<LedgerFunction>()(
  "LedgerBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const ledger = yield* BindingsLedger;
    const CL = Azure.ConfidentialLedger;
    const createLedgerEntry = yield* CL.CreateLedgerEntry(ledger);
    const getLedgerEntry = yield* CL.GetLedgerEntry(ledger);
    const getCurrentLedgerEntry = yield* CL.GetCurrentLedgerEntry(ledger);
    const listLedgerEntries = yield* CL.ListLedgerEntries(ledger);
    const getReceipt = yield* CL.GetReceipt(ledger);
    const getTransactionStatus = yield* CL.GetTransactionStatus(ledger);
    const getEnclaveQuotes = yield* CL.GetEnclaveQuotes(ledger);
    const getConstitution = yield* CL.GetConstitution(ledger);
    const listCollections = yield* CL.ListCollections(ledger);
    const listTags = yield* CL.ListTags(ledger);
    const listConsortiumMembers = yield* CL.ListConsortiumMembers(ledger);
    const getLedgerIdentity = yield* CL.GetLedgerIdentity(ledger);
    const read = yield* CL.LedgerRead(ledger);
    const write = yield* CL.LedgerWrite(ledger);
    const readWrite = yield* CL.LedgerReadWrite(ledger);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const value = url.searchParams.get("value") ?? "";
        const transactionId = url.searchParams.get("tx") ?? "";
        const collection = url.searchParams.get("c") ?? COLLECTION;
        switch (url.pathname) {
          case "/create":
            return yield* respond(
              createLedgerEntry({ contents: value, collectionId: collection, tags: TAG }),
            );
          case "/entry":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* getLedgerEntry({ transactionId, collectionId: collection });
                // An unknown transaction is a typed NotFound.
                const missing = yield* failureTag(
                  getLedgerEntry({ transactionId: "2.999999999", collectionId: collection }),
                );
                return { state: found.state, contents: found.entry?.contents, missing };
              }),
            );
          case "/current":
            return yield* respond(getCurrentLedgerEntry({ collectionId: collection }));
          case "/list":
            return yield* respond(
              Effect.map(listLedgerEntries({ collectionId: collection }), (page) => ({
                state: page.state,
                entries: page.entries.map((entry) => ({
                  transactionId: entry.transactionId,
                  contents: entry.contents,
                })),
              })),
            );
          case "/receipt":
            return yield* respond(
              Effect.map(getReceipt({ transactionId }), (receipt) => ({
                state: receipt.state,
                transactionId: receipt.transactionId,
                signed: (receipt.receipt?.signature ?? "").length > 0,
              })),
            );
          case "/status":
            return yield* respond(getTransactionStatus({ transactionId }));
          case "/quotes":
            return yield* respond(
              Effect.map(getEnclaveQuotes(), (quotes) => ({
                currentNodeId: quotes.currentNodeId,
                hasCurrent: quotes.enclaveQuotes[quotes.currentNodeId] !== undefined,
              })),
            );
          case "/constitution":
            return yield* respond(
              Effect.map(getConstitution(), (constitution) => constitution.digest),
            );
          case "/collections":
            return yield* respond(
              Effect.map(listCollections(), (collections) =>
                collections.map((found) => found.collectionId),
              ),
            );
          case "/tags":
            return yield* respond(listTags({ collectionId: collection }));
          case "/members":
            return yield* respond(
              Effect.map(listConsortiumMembers(), (members) => members.map((member) => member.id)),
            );
          case "/identity":
            return yield* respond(getLedgerIdentity());
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const current = yield* read.getCurrentEntry({ collectionId: collection });
                const status = yield* read.getTransactionStatus({
                  transactionId: current.transactionId ?? "",
                });
                const collections = yield* read.listCollections();
                const tags = yield* read.listTags({ collectionId: collection });
                return {
                  contents: current.contents,
                  status: status.state,
                  collections: collections.map((found) => found.collectionId),
                  tags,
                };
              }),
            );
          case "/write":
            return yield* respond(
              write.createEntry({ contents: value, collectionId: collection, tags: TAG }),
            );
          case "/read-write":
            return yield* respond(
              Effect.gen(function* () {
                const written = yield* readWrite.createEntry({
                  contents: value,
                  collectionId: collection,
                });
                const status = yield* readWrite.getTransactionStatus({
                  transactionId: written.transactionId ?? "",
                });
                return { transactionId: written.transactionId, status: status.transactionId };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.ConfidentialLedger.CreateLedgerEntryHttp,
        Azure.ConfidentialLedger.GetLedgerEntryHttp,
        Azure.ConfidentialLedger.GetCurrentLedgerEntryHttp,
        Azure.ConfidentialLedger.ListLedgerEntriesHttp,
        Azure.ConfidentialLedger.GetReceiptHttp,
        Azure.ConfidentialLedger.GetTransactionStatusHttp,
        Azure.ConfidentialLedger.GetEnclaveQuotesHttp,
        Azure.ConfidentialLedger.GetConstitutionHttp,
        Azure.ConfidentialLedger.ListCollectionsHttp,
        Azure.ConfidentialLedger.ListTagsHttp,
        Azure.ConfidentialLedger.ListConsortiumMembersHttp,
        Azure.ConfidentialLedger.GetLedgerIdentityHttp,
        Azure.ConfidentialLedger.LedgerReadHttp,
        Azure.ConfidentialLedger.LedgerWriteHttp,
        Azure.ConfidentialLedger.LedgerReadWriteHttp,
      ),
    ),
  ),
) {}
