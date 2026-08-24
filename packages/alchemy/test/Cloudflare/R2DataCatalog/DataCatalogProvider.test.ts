import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthProvider.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import {
  DataCatalog,
  DataCatalogProvider,
} from "@/Cloudflare/R2/DataCatalog.ts";
import { Provider } from "@/Provider.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const TEST_ACCOUNT = "test-account-id";
const TEST_BUCKET = "test-bucket";
const INSTANCE_ID = "0123456789abcdef0123456789abcdef";

const jsonResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  result: unknown,
  status = 200,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(result), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const stubbedEnv = (client: HttpClient.HttpClient) =>
  Layer.mergeAll(
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("test-api-token"),
        accountId: TEST_ACCOUNT,
        source: { type: "env" },
      } satisfies CloudflareResolvedCredentials),
    ),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-api-token" })),
    ),
    Layer.succeed(HttpClient.HttpClient, client),
  );

describe("R2 DataCatalog provider", () => {
  it.effect(
    "registers an absent credential before updating dirty maintenance on create",
    () => {
      const calls: string[] = [];
      let catalogReads = 0;
      const catalogPath = `/client/v4/accounts/${TEST_ACCOUNT}/r2-catalog/${TEST_BUCKET}`;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);

          if (request.method === "GET" && path === catalogPath) {
            catalogReads += 1;
            if (catalogReads === 1) {
              return jsonResponse(
                request,
                {
                  success: false,
                  errors: [{ code: 40401, message: "Warehouse not found" }],
                },
                404,
              );
            }
            return jsonResponse(request, {
              success: true,
              result: {
                id: "catalog-id",
                bucket: TEST_BUCKET,
                name: `${TEST_ACCOUNT}_${TEST_BUCKET}`,
                status: "active",
                credential_status: "absent",
                maintenance_config: {
                  compaction: { state: "disabled", target_size_mb: "128" },
                },
              },
            });
          }

          if (path === `${catalogPath}/maintenance-configs`) {
            return jsonResponse(request, {
              success: true,
              result: {
                compaction: { state: "enabled", target_size_mb: "256" },
              },
            });
          }

          return jsonResponse(request, { success: true, result: {} });
        }),
      );

      return Effect.gen(function* () {
        const provider = yield* Provider<DataCatalog>(
          "Cloudflare.R2.DataCatalog",
        );
        yield* provider.reconcile({
          id: "Catalog",
          fqn: "Catalog",
          instanceId: INSTANCE_ID,
          news: {
            bucketName: TEST_BUCKET,
            compaction: { state: "enabled", targetSizeMb: "256" },
            token: Redacted.make("maintenance-token"),
          },
          olds: undefined,
          output: undefined,
          bindings: [] as never,
          session: {
            emit: () => Effect.void,
            done: () => Effect.void,
            note: () => Effect.void,
          },
        });

        expect(
          calls.filter(
            (call) =>
              call.endsWith("/credential") ||
              call.endsWith("/maintenance-configs"),
          ),
        ).toEqual([
          `POST ${catalogPath}/credential`,
          `POST ${catalogPath}/maintenance-configs`,
        ]);
      }).pipe(
        Effect.provide(DataCatalogProvider()),
        Effect.provide(stubbedEnv(client)),
      );
    },
  );
});
