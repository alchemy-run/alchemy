import * as Azure from "@alchemy.run/azure";
import { Credentials, type Config } from "@distilled.cloud/azure";
import * as geocatalog from "@distilled.cloud/azure/orbital-planetary-computer";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import GcBindingsFunction, { COLLECTION, Catalog } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

describe("GeoCatalog request encoding", { tags: ["provider:azure"] }, () => {
  /** Capture the one request an operation sends, with a token per audience. */
  const captured = <A, E>(
    operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    body: string,
  ) =>
    Effect.gen(function* () {
      const calls: { method: string; url: string; auth?: string; body?: string }[] = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, url) =>
          Effect.sync(() => {
            calls.push({
              method: request.method,
              url: url.href,
              auth: request.headers.authorization,
              body:
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : undefined,
            });
            return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }));
          }),
        ),
      );
      const credentials = Layer.succeed(
        Credentials,
        Effect.succeed<Config>({
          bearerToken: Redacted.make("arm-token"),
          subscriptionId: "00000000-0000-0000-0000-000000000001",
          apiBaseUrl: "https://management.azure.com",
          tokenFor: (scope: string) => Effect.succeed(Redacted.make(`aad:${scope}`)),
        }),
      );
      const result = yield* operation.pipe(
        Effect.provide(credentials),
        Effect.provide(http),
        Effect.result,
      );
      return { calls, result };
    });

  const endpoint = "https://imagery.abc123.eastus.geocatalog.spatio.azure.com";

  test(
    "GetStacItem reads one item with a GeoCatalog token",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        geocatalog.GetStacItem({ endpoint, collectionId: "sentinel-2", itemId: "S2A_1" }),
        JSON.stringify({
          type: "Feature",
          id: "S2A_1",
          geometry: { type: "Point", coordinates: [0, 0] },
          bbox: [0, 0, 0, 0],
          properties: { datetime: "2024-01-01T00:00:00Z" },
          assets: {},
          links: [],
          stac_version: "1.0.0",
        }),
      );
      expect(calls.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
        {
          method: "GET",
          url: `${endpoint}/stac/collections/sentinel-2/items/S2A_1?api-version=2026-04-15`,
          auth: "Bearer aad:https://geocatalog.spatio.azure.com/.default",
        },
      ]);
    }),
  );

  test(
    "CreateStacSearch posts the search body",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        geocatalog.CreateStacSearch({ endpoint, collections: ["sentinel-2"], limit: 5 }),
        '{"type":"FeatureCollection","features":[],"links":[]}',
      );
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        { method: "POST", url: `${endpoint}/stac/search?api-version=2026-04-15` },
      ]);
      expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ collections: ["sentinel-2"], limit: 5 });
    }),
  );
});

/** Built-in **GeoCatalog Reader**: the deployer's out-of-band reads. */
const GEOCATALOG_READER = "b7b8f583-43d0-40ae-b147-6b46f53661c1";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureGeoCatalogBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* GcBindingsFunction;
    const catalog = yield* Catalog;
    const deployer = yield* callerObjectId;
    yield* Azure.Authorization.RoleAssignment("GcDeployerReader", {
      scope: catalog.catalogId,
      roleDefinitionId: GEOCATALOG_READER,
      principalId: deployer,
    });
    return { url: fn.url, catalogUri: catalog.catalogUri };
  }),
);

// A GeoCatalog costs ~$0 idle, but a create takes more than 15 minutes and
// a delete runs in the background for 30+ minutes (see GeoCatalog.test.ts):
// ~1 hour per run.
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 3_600_000 }) : undefined;

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/** Call a binding route until it answers `ok` (cold start, role propagation). */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack!;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The collection as the deployer sees it (`"gone"` once deleted), through role propagation. */
const observedCollection = Effect.gen(function* () {
  const { catalogUri } = yield* stack!;
  return yield* geocatalog.GetStacCollection({
    endpoint: catalogUri ?? "",
    collectionId: COLLECTION,
  });
}).pipe(
  Effect.map((collection) => collection.id),
  Effect.catchTag("NotFound", () => Effect.succeed("gone")),
  Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
  Effect.provide(azure),
);

describe.skipIf(!runExpensive)(
  "GeoCatalog bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:planetarycomputer", "live"] },
  () => {
    describe("PlanetaryComputer.GetStacLandingPage", () => {
      test(
        "reads the catalog's landing page",
        Effect.gen(function* () {
          const body = yield* call("/landing");
          expectOk(body);
          expect(typeof body.result.id).toEqual("string");
        }),
        { timeout: 400_000 },
      );
    });

    describe("PlanetaryComputer.CreateStacCollection", () => {
      test(
        "creates the collection",
        Effect.gen(function* () {
          expectOk(yield* call("/collection/create"));
          expect(yield* observedCollection).toEqual(COLLECTION);
        }),
        { timeout: 400_000 },
      );
    });

    describe("PlanetaryComputer.GetStacCollection", () => {
      test(
        "reads the collection",
        Effect.gen(function* () {
          const body = yield* call("/collection/get");
          expectOk(body);
          expect(body.result).toEqual({ id: COLLECTION });
        }),
        { timeout: 300_000 },
      );
    });

    describe("PlanetaryComputer.GetStacCollectionAll", () => {
      test(
        "lists the collection",
        Effect.gen(function* () {
          const body = yield* call("/collection/list");
          expectOk(body);
          expect(body.result.ids).toContain(COLLECTION);
        }),
        { timeout: 300_000 },
      );
    });

    describe("PlanetaryComputer.DeleteStacCollection", () => {
      test(
        "deletes the collection",
        Effect.gen(function* () {
          expectOk(yield* call("/collection/delete"));
          const status = yield* observedCollection.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (s) => s === "gone",
              times: 18,
            }),
          );
          expect(status).toEqual("gone");
        }),
        { timeout: 400_000 },
      );
    });
  },
);

if (runExpensive) {
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });
}
