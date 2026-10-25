import * as Azure from "@alchemy.run/azure";
import { Credentials, type Config } from "@distilled.cloud/azure";
import * as bookshelf from "@distilled.cloud/azure/discovery-bookshelf";
import * as workspace from "@distilled.cloud/azure/discovery-workspace";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import DiscoBindingsFunction from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

describe("Microsoft Discovery request encoding", { tags: ["provider:azure"] }, () => {
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

  test(
    "ListKnowledgeBases reads the bookshelf with a Discovery token",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        bookshelf.ListKnowledgeBases({ endpoint: "https://shelf.bookshelf.discovery.azure.com" }),
        '{"value":[]}',
      );
      expect(calls.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
        {
          method: "GET",
          url: "https://shelf.bookshelf.discovery.azure.com/knowledgeBases?api-version=2026-06-01",
          auth: "Bearer aad:https://discovery.azure.com/.default",
        },
      ]);
    }),
  );

  test(
    "ListInvestigations addresses the project's investigations",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        workspace.ListInvestigations({
          endpoint: "https://lab.workspace.discovery.azure.com",
          projectName: "materials",
        }),
        '{"value":[]}',
      );
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: "GET",
          url: "https://lab.workspace.discovery.azure.com/projects/materials/investigations?api-version=2026-06-01",
        },
      ]);
    }),
  );
});

const Stack = Alchemy.Stack(
  "AzureDiscoveryBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DiscoBindingsFunction;
    return { url: fn.url };
  }),
);

// Microsoft Discovery is a gated preview (InvalidResourceType on the
// testing subscription, see Bookshelf.test.ts / Workspace.test.ts). A
// bookshelf and a workspace provision managed AI Search, storage and
// Cosmos DB: ~$3-8 and 20-40 minutes per run; runs only with
// AZURE_TEST_PAID=1.
const stack = runPaidOnly ? beforeAll(deploy(Stack), { timeout: 3_600_000 }) : undefined;

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

describe.skipIf(!runPaidOnly)(
  "Microsoft Discovery bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:discovery", "live"] },
  () => {
    describe("Discovery.ListKnowledgeBases", () => {
      test(
        "answers an empty page on a new bookshelf",
        Effect.gen(function* () {
          const body = yield* call("/knowledge-bases");
          expectOk(body);
          expect(body.result).toEqual(0);
        }),
        { timeout: 400_000 },
      );
    });

    describe("Discovery.ListConversations", () => {
      test(
        "answers an empty page on a new workspace",
        Effect.gen(function* () {
          const body = yield* call("/conversations");
          expectOk(body);
          expect(body.result).toEqual(0);
        }),
        { timeout: 400_000 },
      );
    });
  },
);

if (runPaidOnly) {
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });
}
