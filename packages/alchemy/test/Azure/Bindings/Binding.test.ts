import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { managedIdentityToken } from "@/Azure/Binding";
import {
  makeReadBlobContainerClient,
  makeWriteBlobContainerClient,
} from "@/Azure/Storage/BlobContainerHttp";
import { makeReceiveStorageQueueClient } from "@/Azure/Storage/StorageQueueHttp";

type Handler = (request: HttpClientRequest.HttpClientRequest) => Response;

/** Mock client; identity-endpoint requests get a token, the rest `handler`. */
const mockHttp = (handler: Handler, seen: HttpClientRequest.HttpClientRequest[] = []) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      seen.push(request);
      const response = request.url.startsWith("http://identity.local")
        ? new Response(
            JSON.stringify({
              access_token: "tok",
              expires_on: String(Math.floor(Date.now() / 1000) + 3600),
            }),
          )
        : handler(request);
      return HttpClientResponse.fromWeb(request, response);
    }),
  );

const withIdentityEnv = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = [process.env.IDENTITY_ENDPOINT, process.env.IDENTITY_HEADER];
      process.env.IDENTITY_ENDPOINT = "http://identity.local/msi/token";
      process.env.IDENTITY_HEADER = "secret-header";
      return prev;
    }),
    () => effect,
    ([endpoint, header]) =>
      Effect.sync(() => {
        if (endpoint === undefined) delete process.env.IDENTITY_ENDPOINT;
        else process.env.IDENTITY_ENDPOINT = endpoint;
        if (header === undefined) delete process.env.IDENTITY_HEADER;
        else process.env.IDENTITY_HEADER = header;
      }),
  );

const ctx = (http: HttpClient.HttpClient) => ({
  tag: "test",
  http,
  containerUrl: Effect.succeed("https://acct.blob.core.windows.net/files"),
  queueUrl: Effect.succeed("https://acct.queue.core.windows.net/jobs"),
});

describe("Azure bindings (HTTP clients)", { tags: ["unit", "provider:azure", "local"] }, () => {
  test(
    "managedIdentityToken calls the identity endpoint with the resource",
    () =>
      withIdentityEnv(
        Effect.gen(function* () {
          const seen: HttpClientRequest.HttpClientRequest[] = [];
          const token = yield* managedIdentityToken("https://unit-test.azure.net/.default").pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              mockHttp(() => new Response("", { status: 500 }), seen),
            ),
          );
          expect(token).toBe("tok");
          expect(seen[0]!.headers["x-identity-header"]).toBe("secret-header");
          expect(
            seen[0]!.urlParams.params.some(
              ([k, v]) => k === "resource" && v === "https://unit-test.azure.net/",
            ),
          ).toBe(true);
        }),
      ).pipe(Effect.runPromise),
    { exclusive: true },
  );

  test(
    "blob client lists, misses, and puts with bearer auth",
    () =>
      withIdentityEnv(
        Effect.gen(function* () {
          const seen: HttpClientRequest.HttpClientRequest[] = [];
          const http = mockHttp((request) => {
            if (request.method === "GET" && request.url.endsWith("/files")) {
              return new Response(
                "<EnumerationResults><Blobs><Blob><Name>a&amp;b.txt</Name><Properties><Content-Length>3</Content-Length><Content-Type>text/plain</Content-Type></Properties></Blob></Blobs><NextMarker>m2</NextMarker></EnumerationResults>",
              );
            }
            if (request.url.endsWith("/missing")) {
              return new Response("", {
                status: 404,
                headers: { "x-ms-error-code": "BlobNotFound" },
              });
            }
            return new Response("", {
              status: 201,
              headers: { etag: '"e1"' },
            });
          }, seen);
          const read = makeReadBlobContainerClient(ctx(http));
          const write = makeWriteBlobContainerClient(ctx(http));

          const page = yield* read.list({ prefix: "a" });
          expect(page.blobs).toEqual([
            {
              key: "a&b.txt",
              size: 3,
              contentType: "text/plain",
              etag: undefined,
              lastModified: undefined,
            },
          ]);
          expect(page.nextMarker).toBe("m2");
          expect(yield* read.get("missing")).toBeUndefined();
          const put = yield* write.put("dir/x.json", "{}", {
            contentType: "application/json",
          });
          expect(put.etag).toBe('"e1"');
          const putRequest = seen.find((r) => r.method === "PUT")!;
          expect(putRequest.url).toBe("https://acct.blob.core.windows.net/files/dir/x.json");
          expect(putRequest.headers["x-ms-blob-type"]).toBe("BlockBlob");
          expect(putRequest.headers["authorization"]).toBe("Bearer tok");
        }),
      ).pipe(Effect.runPromise),
    { exclusive: true },
  );

  test(
    "storage queue receive parses messages",
    () =>
      withIdentityEnv(
        Effect.gen(function* () {
          const http = mockHttp(
            () =>
              new Response(
                "<QueueMessagesList><QueueMessage><MessageId>id1</MessageId><InsertionTime>t</InsertionTime><PopReceipt>pr</PopReceipt><DequeueCount>2</DequeueCount><MessageText>hi &lt;there&gt;</MessageText></QueueMessage></QueueMessagesList>",
              ),
          );
          const messages = yield* makeReceiveStorageQueueClient(ctx(http)).receive({
            maxMessages: 4,
          });
          expect(messages).toEqual([
            {
              messageId: "id1",
              popReceipt: "pr",
              text: "hi <there>",
              dequeueCount: 2,
              insertionTime: "t",
            },
          ]);
        }),
      ).pipe(Effect.runPromise),
    { exclusive: true },
  );
});
