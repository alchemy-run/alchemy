import { createHash } from "node:crypto";
import {
  AssetDeployment,
  AssetDeploymentProvider,
  type AssetDeploymentProps,
} from "@alchemy.run/aws/Website/AssetDeployment";
import { describe, expect, it } from "@alchemy.run/test";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import type * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

interface StoredObject {
  etag: string;
  contentType: string | undefined;
  cacheControl: string | undefined;
}

const bucketName = "asset-metadata-test";
const sourcePath = `${import.meta.dirname}/fixtures/asset-deployment-v1`;

const fakeS3 = () => {
  const objects = new Map<string, StoredObject>();
  const puts: string[] = [];
  const escapeXml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const respond = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) => {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, "").replace(`${bucketName}/`, ""));
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(
          ([objectKey, object]) =>
            `<Contents><Key>${escapeXml(objectKey)}</Key><ETag>${escapeXml(`"${object.etag}"`)}</ETag><Size>1</Size></Contents>`,
        );
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucketName}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }
    if (request.method === "PUT") {
      const body = request.body as HttpBody.HttpBody;
      const bytes = body._tag === "Uint8Array" ? body.body : new Uint8Array();
      const etag = createHash("md5").update(bytes).digest("hex");
      objects.set(key, {
        etag,
        contentType: request.headers["content-type"],
        cacheControl: request.headers["cache-control"],
      });
      puts.push(key);
      return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
    }
    return new Response(`unhandled ${request.method} ${request.url}`, { status: 501 });
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
  );
  return { objects, puts, http };
};

const deploy = (
  news: Omit<AssetDeploymentProps, "bucket" | "sourcePath">,
  output: AssetDeployment["Attributes"] | undefined,
) =>
  Effect.gen(function* () {
    const provider = yield* AssetDeployment.Provider;
    return yield* provider.reconcile({
      id: "WebsiteFiles",
      fqn: "WebsiteFiles",
      instanceId: "00000000000000000000000000000000",
      news: { bucket: { bucketName }, sourcePath, prefix: "site", ...news },
      olds: undefined,
      output,
      session: { note: () => Effect.void } as never,
      bindings: [],
    });
  });

const providerWith = (http: HttpClient.HttpClient) =>
  AssetDeploymentProvider().pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        PlatformServices,
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(
          Credentials,
          Effect.succeed({
            accessKeyId: Redacted.make("test"),
            secretAccessKey: Redacted.make("test"),
            sessionToken: undefined,
            region: "us-east-1",
          }),
        ),
      ),
    ),
  );

describe(
  "AssetDeployment object metadata",
  { tags: ["unit", "provider:aws", "provider:aws:website"] },
  () => {
    it.effect("uploads unchanged files again when their fileOptions change", () => {
      const s3 = fakeS3();
      return Effect.gen(function* () {
        const first = yield* deploy({}, undefined);
        expect(s3.puts.sort()).toEqual(["site/about.html", "site/index.html", "site/robots.txt"]);

        s3.puts.length = 0;
        const unchanged = yield* deploy({}, first);
        expect(s3.puts).toEqual([]);

        const cacheControl = "max-age=0,public,must-revalidate";
        const changed = yield* deploy(
          { fileOptions: [{ files: "robots.txt", cacheControl }] },
          unchanged,
        );
        expect(s3.puts).toEqual(["site/robots.txt"]);
        expect(s3.objects.get("site/robots.txt")?.cacheControl).toBe(cacheControl);
        expect(changed.version).not.toBe(unchanged.version);

        s3.puts.length = 0;
        yield* deploy(
          { fileOptions: [{ files: "about.html", contentType: "text/plain" }] },
          changed,
        );
        expect(s3.puts.sort()).toEqual(["site/about.html", "site/robots.txt"]);
        expect(s3.objects.get("site/about.html")?.contentType).toBe("text/plain");
      }).pipe(Effect.provide(providerWith(s3.http)));
    });

    it.effect("uploads every file when the previous deploy has no metadata record", () => {
      const s3 = fakeS3();
      return Effect.gen(function* () {
        const first = yield* deploy({}, undefined);
        s3.puts.length = 0;
        const { fileMetadata: _, ...legacy } = first;
        yield* deploy({}, legacy);
        expect(s3.puts.sort()).toEqual(["site/about.html", "site/index.html", "site/robots.txt"]);
      }).pipe(Effect.provide(providerWith(s3.http)));
    });
  },
);
