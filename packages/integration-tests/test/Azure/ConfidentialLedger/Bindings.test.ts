import * as Azure from "@alchemy.run/azure";
import * as confidentialledger from "@distilled.cloud/azure/confidentialledger";
import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as identity from "@distilled.cloud/azure/confidentialledger-identity";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import LedgerFunction, {
  BindingsLedger,
  LedgerGroup,
  TAG,
  ledgerAdmin,
} from "./fixtures/function.ts";
import { callerObjectId, waitGone } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureConfidentialLedgerBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    // The deployer administers the ledger, so it can verify each binding.
    ledgerAdmin.objectId = yield* callerObjectId;
    const fn = yield* LedgerFunction;
    const group = yield* LedgerGroup;
    const ledger = yield* BindingsLedger;
    return {
      url: fn.url,
      principalId: fn.principalId,
      ledgerName: ledger.ledgerName,
      ledgerUri: ledger.ledgerUri,
      resourceGroup: group.resourceGroupName,
    };
  }),
);

// Standard ledger ~$0.13/hour while running (~4 min create, ~3 min delete)
// + Flex Consumption (~$0.01/run): about $0.03 per run, ~10 minutes.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and the ledger-user propagation (about 4 minutes), then return
 * the last answer so a real failure shows its ledger error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

/** Call a route until `until` holds on its result (bounded), e.g. a `Ready` query. */
const callUntil = (route: string, until: (result: any) => boolean) =>
  call(route).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => !body.ok || until(body.result),
      times: 15,
    }),
  );

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Run deployer data-plane calls over TLS that trusts the ledger's certificate. */
const asDeployer = <A, E, R>(effect: (ledgerEndpoint: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const { ledgerName, ledgerUri } = yield* stack;
    const ledgerIdentity = yield* identity.GetLedgerIdentity({ ledgerId: ledgerName });
    return yield* effect(ledgerUri).pipe(
      Effect.provide(
        NodeHttpClient.layerNodeHttpOptions({ ca: ledgerIdentity.ledgerTlsCertificate }),
      ),
    );
  }).pipe(Effect.provide(azure));

/** Write an entry as the deployer and wait until it is committed. */
const deployerWrite = (contents: string, collectionId: string, tags?: string) =>
  asDeployer((ledgerEndpoint) =>
    Effect.gen(function* () {
      const written = yield* data.CreateLedgerEntry({
        ledgerEndpoint,
        contents,
        collectionId,
        tags,
      });
      const transactionId = written.transactionId ?? "";
      yield* data.GetTransactionStatus({ ledgerEndpoint, transactionId }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (status) => status.state === "Committed",
          times: 15,
        }),
      );
      return transactionId;
    }),
  );

/** Read an entry as the deployer once the ledger has loaded it. */
const deployerEntry = (transactionId: string, collectionId: string) =>
  asDeployer((ledgerEndpoint) =>
    data.GetLedgerEntry({ ledgerEndpoint, transactionId, collectionId }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (result) => result.state === "Ready",
        times: 15,
      }),
    ),
  );

/** Wait until a write the Function made is committed (deployer view). */
const committed = (transactionId: string) =>
  asDeployer((ledgerEndpoint) =>
    data.GetTransactionStatus({ ledgerEndpoint, transactionId }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status.state === "Committed",
        times: 15,
      }),
    ),
  );

describe(
  "Confidential Ledger data-plane bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:confidentialledger", "live"] },
  () => {
    describe("ConfidentialLedger.LedgerRoleAssignment (binding grants)", () => {
      test(
        "the Function's identity is a ledger Reader and Contributor",
        Effect.gen(function* () {
          const { principalId } = yield* stack;
          // Wait for the Function to be reachable, so every grant is applied.
          expectOk(yield* call("/constitution"));
          const user = yield* asDeployer((ledgerEndpoint) =>
            data.GetLedgerUser({ ledgerEndpoint, userId: principalId }),
          );
          expect([...user.assignedRoles].sort()).toEqual(["Contributor", "Reader"]);
        }),
        { timeout: 300_000 },
      );

      test(
        "data-plane users do not show up in the ledger's ARM principals",
        Effect.gen(function* () {
          const { ledgerName, resourceGroup, principalId } = yield* stack;
          const ledger = yield* Effect.gen(function* () {
            const { subscriptionId } = yield* Azure.AzureEnvironment.current;
            return yield* confidentialledger.GetLedger({
              subscriptionId,
              resourceGroupName: resourceGroup,
              ledgerName,
            });
          }).pipe(Effect.provide(azure));
          const principals = (ledger.properties?.aadBasedSecurityPrincipals ?? []).map(
            (p) => p.principalId,
          );
          expect(principals).toEqual([ledgerAdmin.objectId]);
          expect(principals).not.toContain(principalId);
        }),
        { timeout: 120_000 },
      );
    });

    describe("ConfidentialLedger.CreateLedgerEntry", () => {
      test(
        "appends an entry the deployer reads back",
        Effect.gen(function* () {
          const body = yield* call("/create?c=create&value=created-by-function");
          expectOk(body);
          expect(body.result.collectionId).toEqual("create");
          const transactionId: string = body.result.transactionId;
          expect(transactionId).toMatch(/^\d+\.\d+$/);
          yield* committed(transactionId);
          const entry = yield* deployerEntry(transactionId, "create");
          expect(entry.entry?.contents).toEqual("created-by-function");
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.GetTransactionStatus", () => {
      test(
        "reports a deployer write as committed",
        Effect.gen(function* () {
          const transactionId = yield* deployerWrite("status", "status");
          const body = yield* call(`/status?tx=${transactionId}`);
          expectOk(body);
          expect(body.result).toEqual({ state: "Committed", transactionId });
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.GetLedgerEntry", () => {
      test(
        "reads a deployer write; an unknown transaction is NotFound",
        Effect.gen(function* () {
          const transactionId = yield* deployerWrite("entry-contents", "entry");
          const body = yield* callUntil(
            `/entry?c=entry&tx=${transactionId}`,
            (result) => result.state === "Ready",
          );
          expectOk(body);
          expect(body.result).toEqual({
            state: "Ready",
            contents: "entry-contents",
            missing: "NotFound",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.GetCurrentLedgerEntry", () => {
      test(
        "reads the latest entry of a collection",
        Effect.gen(function* () {
          yield* deployerWrite("first", "current");
          const transactionId = yield* deployerWrite("latest", "current");
          const body = yield* call("/current?c=current");
          expectOk(body);
          expect(body.result).toEqual({
            contents: "latest",
            collectionId: "current",
            transactionId,
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.ListLedgerEntries", () => {
      test(
        "lists the entries of a collection",
        Effect.gen(function* () {
          // The ledger is append-only: keep only this run's writes.
          const one = yield* deployerWrite("one", "list");
          const two = yield* deployerWrite("two", "list");
          const body = yield* callUntil("/list?c=list", (result) => result.state === "Ready");
          expectOk(body);
          expect(body.result.state).toEqual("Ready");
          const entries: { transactionId: string; contents: string }[] = body.result.entries;
          expect(
            entries.filter((entry) => entry.transactionId === one || entry.transactionId === two),
          ).toEqual([
            { transactionId: one, contents: "one" },
            { transactionId: two, contents: "two" },
          ]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.GetReceipt", () => {
      test(
        "returns a signed receipt for a committed write",
        Effect.gen(function* () {
          const transactionId = yield* deployerWrite("receipt", "receipt");
          const body = yield* callUntil(
            `/receipt?tx=${transactionId}`,
            (result) => result.state === "Ready",
          );
          expectOk(body);
          expect(body.result).toEqual({ state: "Ready", transactionId, signed: true });
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.GetEnclaveQuotes", () => {
      test(
        "returns the quote of the answering node",
        Effect.gen(function* () {
          const body = yield* call("/quotes");
          expectOk(body);
          expect(body.result.hasCurrent).toEqual(true);
          const quotes = yield* asDeployer((ledgerEndpoint) =>
            data.GetEnclaveQuotes({ ledgerEndpoint }),
          );
          expect(Object.keys(quotes.enclaveQuotes)).toContain(body.result.currentNodeId);
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.GetConstitution", () => {
      test(
        "returns the constitution digest the deployer sees",
        Effect.gen(function* () {
          const body = yield* call("/constitution");
          expectOk(body);
          const constitution = yield* asDeployer((ledgerEndpoint) =>
            data.GetConstitution({ ledgerEndpoint }),
          );
          expect(body.result).toEqual(constitution.digest);
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.ListCollections", () => {
      test(
        "lists a collection the deployer wrote to",
        Effect.gen(function* () {
          yield* deployerWrite("collection", "listed");
          const body = yield* call("/collections");
          expectOk(body);
          expect(body.result).toContain("listed");
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.ListTags", () => {
      test(
        "lists the tags of a collection",
        Effect.gen(function* () {
          yield* deployerWrite("tagged", "tags", "red");
          const body = yield* call("/tags?c=tags");
          expectOk(body);
          expect(body.result).toEqual(["red"]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.ListConsortiumMembers", () => {
      test(
        "lists the consortium members the deployer sees",
        Effect.gen(function* () {
          const body = yield* call("/members");
          expectOk(body);
          const consortium = yield* asDeployer((ledgerEndpoint) =>
            data.ListConsortiumMembers({ ledgerEndpoint }),
          );
          expect(body.result).toEqual(consortium.members.map((member) => member.id));
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.GetLedgerIdentity", () => {
      test(
        "returns the ledger's TLS certificate",
        Effect.gen(function* () {
          const { ledgerName } = yield* stack;
          const body = yield* call("/identity");
          expectOk(body);
          const expected = yield* identity
            .GetLedgerIdentity({ ledgerId: ledgerName })
            .pipe(Effect.provide(azure));
          expect(body.result.ledgerTlsCertificate).toEqual(expected.ledgerTlsCertificate);
          expect(body.result.ledgerTlsCertificate).toMatch(/^-----BEGIN CERTIFICATE-----/);
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.LedgerRead", () => {
      test(
        "reads the latest entry, its status, collections and tags",
        Effect.gen(function* () {
          yield* deployerWrite("read-level", "readlevel", "blue");
          const body = yield* call("/read?c=readlevel");
          expectOk(body);
          expect(body.result.contents).toEqual("read-level");
          expect(body.result.status).toEqual("Committed");
          expect(body.result.collections).toContain("readlevel");
          expect(body.result.tags).toEqual(["blue"]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.LedgerWrite", () => {
      test(
        "appends a tagged entry the deployer reads back",
        Effect.gen(function* () {
          const body = yield* call("/write?c=writelevel&value=write-level");
          expectOk(body);
          const transactionId: string = body.result.transactionId;
          yield* committed(transactionId);
          const entry = yield* deployerEntry(transactionId, "writelevel");
          expect(entry.entry?.contents).toEqual("write-level");
          const tags = yield* asDeployer((ledgerEndpoint) =>
            data.ListTags({ ledgerEndpoint, collectionId: "writelevel" }),
          );
          expect(tags.tags).toEqual([TAG]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("ConfidentialLedger.LedgerReadWrite", () => {
      test(
        "appends an entry and reads its status",
        Effect.gen(function* () {
          const body = yield* call("/read-write?c=readwrite&value=read-write");
          expectOk(body);
          const transactionId: string = body.result.transactionId;
          expect(body.result.status).toEqual(transactionId);
          yield* committed(transactionId);
          const entry = yield* deployerEntry(transactionId, "readwrite");
          expect(entry.entry?.contents).toEqual("read-write");
        }),
        { timeout: 300_000 },
      );
    });
  },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { ledgerName, resourceGroup } = yield* stack;
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
    expect(
      yield* waitGone(
        confidentialledger
          .GetLedger({ subscriptionId, resourceGroupName: resourceGroup, ledgerName })
          .pipe(Effect.provide(azure)),
      ),
    ).toEqual("gone");
  }),
  { timeout: 900_000 },
);
