import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthProvider";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as SearchInstance from "@/Cloudflare/AI/SearchInstance";
import * as Provider from "@/Provider";
import { Stack, type StackSpec } from "@/Stack";
import { Stage } from "@/Stage";
import {
  Credentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const customMetadata: SearchInstance.CustomMetadata = [
  { fieldName: "title", dataType: "text" },
  { fieldName: "priority", dataType: "number" },
  { fieldName: "published", dataType: "boolean" },
  { fieldName: "published_at", dataType: "datetime" },
];

const invalidCustomMetadata: SearchInstance.CustomMetadata = [
  {
    fieldName: "route",
    // @ts-expect-error Cloudflare calls textual custom metadata "text", not "string".
    dataType: "string",
  },
];

const credentials: CloudflareResolvedCredentials = {
  type: "apiToken",
  apiToken: Redacted.make("test-token"),
  accountId: "00000000000000000000000000000000",
  source: { type: "env" },
};

const cloudflareEnvironment = Layer.succeed(
  CloudflareEnvironment,
  Effect.succeed(credentials),
);

const distilledCredentials = Layer.succeed(
  Credentials,
  Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
);

const stack: Omit<StackSpec, "output"> = {
  name: "ai-search-validation",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};

const resourceContext = Layer.mergeAll(
  Layer.succeed(Stack, stack),
  Layer.succeed(Stage, stack.stage),
);

describe("Cloudflare AI Search custom metadata", () => {
  it.effect(
    "serializes every supported type to the Cloudflare wire shape",
    () => {
      let bodyJson: unknown;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const body = request.body as HttpBody.HttpBody;
          const bodyText =
            body._tag === "Uint8Array"
              ? new TextDecoder().decode(body.body)
              : "";
          bodyJson = JSON.parse(bodyText);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                success: true,
                errors: [],
                messages: [],
                result: {
                  id: "docs-search",
                  created_at: "2026-01-01T00:00:00.000Z",
                  modified_at: "2026-01-01T00:00:00.000Z",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }),
      );

      return Effect.gen(function* () {
        yield* aisearch.createNamespaceInstance({
          accountId: credentials.accountId,
          name: "default",
          id: "docs-search",
          customMetadata,
        });

        expect(bodyJson).toEqual({
          id: "docs-search",
          custom_metadata: [
            { field_name: "title", data_type: "text" },
            { field_name: "priority", data_type: "number" },
            { field_name: "published", data_type: "boolean" },
            { field_name: "published_at", data_type: "datetime" },
          ],
        });
      }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(distilledCredentials),
      );
    },
  );

  for (const output of [
    undefined,
    {
      instanceId: "docs-search",
      accountId: credentials.accountId,
      namespace: "default",
      type: "r2" as const,
      source: "docs",
      embeddingModel: undefined,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ]) {
    const phase = output === undefined ? "create" : "update";

    it.effect(`rejects string before any ${phase} provider request`, () => {
      let requests = 0;
      const http = HttpClient.make(() => {
        requests += 1;
        return Effect.die("invalid custom metadata must fail before HTTP");
      });

      return Effect.gen(function* () {
        const provider = yield* Provider.findProvider(
          SearchInstance.SearchInstance,
        );
        const exit = yield* Effect.exit(
          provider.reconcile({
            id: "Search",
            fqn: "Search",
            instanceId: "00000000000000000000000000000000",
            news: {
              instanceId: "docs-search",
              source: "docs",
              customMetadata: invalidCustomMetadata,
            },
            olds: undefined,
            output: output as never,
            session: undefined as never,
            bindings: [],
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain(
            'customMetadata[0].dataType must be one of "text", "number", "boolean", or "datetime"',
          );
        }
        expect(requests).toBe(0);
      }).pipe(
        Effect.provide(SearchInstance.SearchInstanceProvider()),
        Effect.provide(cloudflareEnvironment),
        Effect.provide(distilledCredentials),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(resourceContext),
      );
    });
  }
});
