import { expect, layer } from "@effect/vitest";
import { AwsClient } from "aws4fetch";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as R2Bucket from "../../bindings/r2-bucket/index.ts";
import * as Assets from "../../bindings/assets/Assets.ts";
import * as WorkerProxy from "../../proxy/WorkerProxy.ts";
import {
  HEADER_ORIGINAL_URL,
  HEADER_PROXY_SHARED_SECRET,
} from "../../globals/ProxyHeaders.shared.ts";
import {
  localRuntimeLayer,
  startTestWorker,
  type TestWorker,
} from "../helpers/runtime.ts";

const credentials = {
  accessKeyId: "local-access-key",
  secretAccessKey: "local-secret-key",
};
const bucketName = "dev:s3-test";
const script = `export default { async fetch(request, env) {
  const key = new URL(request.url).searchParams.get("key") || "native.txt";
  if (request.method === "PUT") {
    await env.BUCKET.put(key, request.body);
    return new Response("written");
  }
  const object = await env.BUCKET.get(key);
  return object ? new Response(object.body) : new Response("missing", { status: 404 });
} };`;
const config = {
  name: "r2-s3-test",
  compatibilityDate: "2026-08-31",
  compatibilityFlags: [],
  r2S3: credentials,
  proxySharedSecret: "trusted-proxy",
  bindings: [
    R2Bucket.local({ binding: "BUCKET", id: bucketName }),
    R2Bucket.local({ binding: "OTHER", id: "other" }),
  ],
  modules: [{ name: "main.js", type: "ESModule" as const, content: script }],
};
const objectUrl = (base: string | URL, key: string, bucket = bucketName) =>
  `${R2Bucket.localS3Endpoint(base)}${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
const sign = (
  url: string,
  method = "GET",
  options: {
    datetime?: string;
    expires?: string;
    headers?: Record<string, string>;
    secretAccessKey?: string;
    accessKeyId?: string;
  } = {},
) =>
  Effect.promise(async () => {
    const target = new URL(url);
    target.searchParams.set("X-Amz-Expires", options.expires ?? "60");
    return new AwsClient({
      ...credentials,
      secretAccessKey: options.secretAccessKey ?? credentials.secretAccessKey,
      accessKeyId: options.accessKeyId ?? credentials.accessKeyId,
      service: "s3",
      region: "auto",
    }).sign(target.toString(), {
      method,
      headers: options.headers,
      aws: { signQuery: true, allHeaders: true, datetime: options.datetime },
    });
  });
const text = (response: Response) => Effect.promise(() => response.text());

class Worker extends Context.Service<Worker, TestWorker>()("test/R2S3") {}
const workerLayer = Layer.effect(Worker, startTestWorker(config)).pipe(
  Layer.provideMerge(localRuntimeLayer),
);

layer(workerLayer, { excludeTestServices: true })(
  "local R2 S3 HTTP endpoint",
  (it) => {
    it.effect(
      "shares presigned uploads and native writes with the binding, including encoded keys and metadata",
      () =>
        Effect.gen(function* () {
          const worker = yield* Worker;
          const key = "folder/a b+%/café.txt";
          const url = objectUrl(worker.baseUrl, key);
          const upload = yield* sign(url, "PUT", {
            headers: {
              "content-type": "text/plain",
              "x-amz-meta-owner": "browser",
            },
          });
          const put = yield* worker.fetch(upload.url, {
            method: "PUT",
            body: "from browser",
            headers: upload.headers,
          });
          expect(put.status).toBe(200);
          expect(put.headers.get("etag")).toMatch(/^".+"$/);
          expect(
            yield* worker.fetchText(`/?key=${encodeURIComponent(key)}`),
          ).toBe("from browser");
          const download = yield* sign(url);
          const get = yield* worker.fetch(download.url, {
            headers: { Origin: "http://localhost:5173" },
          });
          expect(get.status).toBe(200);
          expect(get.headers.get("content-type")).toBe("text/plain");
          expect(get.headers.get("x-amz-meta-owner")).toBe("browser");
          expect(get.headers.get("etag")).toBe(put.headers.get("etag"));
          expect(get.headers.get("access-control-allow-origin")).toBe("*");
          expect(yield* text(get)).toBe("from browser");
          yield* worker.fetch("/?key=native.txt", {
            method: "PUT",
            body: "from worker",
          });
          const native = yield* sign(objectUrl(worker.baseUrl, "native.txt"));
          expect(yield* worker.fetchText(native.url)).toBe("from worker");
          const isolated = yield* sign(
            objectUrl(worker.baseUrl, "native.txt", "other"),
          );
          expect((yield* worker.fetch(isolated.url)).status).toBe(404);
          const range = yield* worker.fetch(native.url, {
            headers: { Range: "bytes=0-3" },
          });
          expect(range.status).toBe(206);
          expect(range.headers.get("content-range")).toBe("bytes 0-3/11");
          expect(yield* text(range)).toBe("from");
          const head = yield* sign(
            objectUrl(worker.baseUrl, "native.txt"),
            "HEAD",
          );
          const metadata = yield* worker.fetch(head.url, { method: "HEAD" });
          expect(metadata.status).toBe(200);
          expect(metadata.headers.get("content-length")).toBe("11");
          expect(yield* text(metadata)).toBe("");
        }),
    );

    it.effect(
      "supports SDK-hoisted metadata and distinguishes unsatisfiable ranges",
      () =>
        Effect.gen(function* () {
          const worker = yield* Worker;
          const url = objectUrl(worker.baseUrl, "metadata.txt");
          const upload = yield* sign(`${url}?x-amz-meta-owner=browser`, "PUT");
          expect(
            (yield* worker.fetch(upload.url, {
              method: "PUT",
              body: "metadata",
            })).status,
          ).toBe(200);
          const download = yield* sign(url);
          const response = yield* worker.fetch(download.url);
          expect(response.headers.get("x-amz-meta-owner")).toBe("browser");
          expect(yield* text(response)).toBe("metadata");
          for (const range of [
            "bytes=999-",
            "bytes=4-2",
            "bytes=-0",
            "invalid",
          ]) {
            const denied = yield* worker.fetch(download.url, {
              headers: { Range: range },
            });
            expect(denied.status).toBe(416);
            expect(denied.headers.get("content-range")).toBe("bytes */8");
            expect(yield* text(denied)).toContain("<Code>InvalidRange</Code>");
          }
          const multiple = yield* worker.fetch(download.url, {
            headers: { Range: "bytes=0-1,4-5" },
          });
          expect(multiple.status).toBe(200);
          expect(multiple.headers.get("content-range")).toBeNull();
          expect(yield* text(multiple)).toBe("metadata");
        }),
    );

    it.effect(
      "allows browser preflight and exposes CORS headers on authentication errors",
      () =>
        Effect.gen(function* () {
          const worker = yield* Worker;
          const url = objectUrl(worker.baseUrl, "preflight.txt");
          const response = yield* worker.fetch(url, {
            method: "OPTIONS",
            headers: {
              Origin: "http://localhost:5173",
              "Access-Control-Request-Method": "PUT",
              "Access-Control-Request-Headers": "content-type,x-amz-meta-owner",
            },
          });
          expect(response.status).toBe(204);
          expect(
            response.headers.get("access-control-allow-methods"),
          ).toContain("PUT");
          expect(response.headers.get("access-control-allow-headers")).toBe(
            "content-type,x-amz-meta-owner",
          );
          const unsigned = yield* worker.fetch(url, {
            method: "PUT",
            body: "denied",
          });
          expect(unsigned.status).toBe(400);
          expect(unsigned.headers.get("access-control-allow-origin")).toBe("*");
          expect(unsigned.headers.get("access-control-expose-headers")).toBe(
            "*",
          );
          expect((yield* worker.fetch("/?key=preflight.txt")).status).toBe(404);
        }),
    );

    it.effect(
      "rejects invalid credentials, expiry, signatures, signed headers and changed method/path/query",
      () =>
        Effect.gen(function* () {
          const worker = yield* Worker;
          const url = objectUrl(worker.baseUrl, "denied.txt");
          const datetime = (offset: number) =>
            new Date(Date.now() + offset)
              .toISOString()
              .replace(/[:-]|\.\d{3}/g, "");
          for (const options of [
            { secretAccessKey: "wrong" },
            { accessKeyId: "wrong" },
            { datetime: datetime(-120000), expires: "1" },
            { datetime: datetime(3600000) },
            { expires: "604801" },
            { expires: "NaN" },
          ]) {
            const signed = yield* sign(url, "PUT", options);
            const response = yield* worker.fetch(signed.url, {
              method: "PUT",
              body: "denied",
            });
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.status).toBeLessThan(500);
          }
          const signed = yield* sign(url, "PUT", {
            headers: { "content-type": "text/plain" },
          });
          for (const [target, method, headers] of [
            [signed.url, "GET", signed.headers],
            [
              signed.url.replace("denied.txt", "different.txt"),
              "PUT",
              signed.headers,
            ],
            [signed.url + "&extra=value", "PUT", signed.headers],
            [signed.url, "PUT", { "content-type": "application/json" }],
            [signed.url, "PUT", {}],
            [signed.url + "&X-Amz-Expires=60", "PUT", signed.headers],
          ] as const) {
            const response = yield* worker.fetch(target, { method, headers });
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.status).toBeLessThan(500);
          }
          expect((yield* worker.fetch("/?key=denied.txt")).status).toBe(404);
          expect((yield* worker.fetch("/?key=different.txt")).status).toBe(404);
        }),
    );

    it.effect(
      "returns S3 errors for unknown buckets, absent keys and unsupported operations",
      () =>
        Effect.gen(function* () {
          const worker = yield* Worker;
          for (const [url, method, code] of [
            [
              objectUrl(worker.baseUrl, "missing", "unknown"),
              "GET",
              "NoSuchBucket",
            ],
            [objectUrl(worker.baseUrl, "missing"), "GET", "NoSuchKey"],
            [objectUrl(worker.baseUrl, "missing"), "DELETE", "NotImplemented"],
            [
              objectUrl(worker.baseUrl, "missing") + "?uploadId=abc",
              "PUT",
              "NotImplemented",
            ],
          ]) {
            const signed = yield* sign(url, method);
            const response = yield* worker.fetch(signed.url, { method });
            expect(yield* text(response)).toContain(`<Code>${code}</Code>`);
          }
        }),
    );

    it.effect(
      "verifies the public URL through the dev proxy and trusted Vite forwarding",
      () =>
        Effect.gen(function* () {
          const worker = yield* Worker;
          const proxy = yield* WorkerProxy.WorkerProxy;
          const instance = yield* proxy.serve();
          yield* instance.set(worker.baseUrl);
          const upload = yield* sign(
            objectUrl(instance.url, "proxy.txt"),
            "PUT",
          );
          expect(
            (yield* worker.fetch(upload.url, {
              method: "PUT",
              body: "proxied",
            })).status,
          ).toBe(200);
          const publicUrl = objectUrl("https://dev.example:8443", "proxy.txt");
          const signed = yield* sign(publicUrl);
          const internal = new URL(signed.url);
          internal.host = worker.baseUrl.host;
          internal.protocol = worker.baseUrl.protocol;
          const response = yield* worker.fetch(internal.href, {
            headers: {
              [HEADER_ORIGINAL_URL]: signed.url,
              [HEADER_PROXY_SHARED_SECRET]: config.proxySharedSecret,
            },
          });
          expect(response.status).toBe(200);
          expect(yield* text(response)).toBe("proxied");
          expect(
            (yield* worker.fetch(internal.href, {
              headers: { [HEADER_ORIGINAL_URL]: signed.url },
            })).status,
          ).toBe(403);
        }).pipe(Effect.scoped),
    );

    it.effect("is disabled by default", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          ...config,
          name: "r2-s3-disabled",
          r2S3: undefined,
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content:
                'export default { fetch() { return new Response("user handler"); } };',
            },
          ],
        });
        expect(yield* worker.fetchText(objectUrl(worker.baseUrl, "key"))).toBe(
          "user handler",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("serves S3 ahead of a static SPA fallback", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${directory}/index.html`, "SPA fallback");
        const worker = yield* startTestWorker({
          ...config,
          name: "r2-s3-assets",
          bindings: [...config.bindings, Assets.local("ASSETS")],
          assets: {
            directory,
            notFoundHandling: "single-page-application",
            runWorkerFirst: ["/api/*"],
          },
        });
        const upload = yield* sign(
          objectUrl(worker.baseUrl, "asset-test.txt"),
          "PUT",
        );
        expect(
          (yield* worker.fetch(upload.url, { method: "PUT", body: "object" }))
            .status,
        ).toBe(200);
        const download = yield* sign(
          objectUrl(worker.baseUrl, "asset-test.txt"),
        );
        expect(yield* worker.fetchText(download.url)).toBe("object");
        expect(
          yield* worker.fetchText("/page", {
            headers: { "Sec-Fetch-Mode": "navigate" },
          }),
        ).toBe("SPA fallback");
      }).pipe(Effect.scoped),
    );
  },
);
