import {
  bucketCredentials,
  bucketEnvKeys,
  bucketKeyLogicalId,
} from "@/Prisma/BucketBinding";
import type { Bucket as PrismaBucket } from "@/Prisma/Bucket";
import type { BucketKey as PrismaBucketKey } from "@/Prisma/BucketKey";
import { BUCKET_SIGNING_REGION } from "@/Prisma/Internal/BucketClient";
import type { BucketAccess } from "@/Prisma/Internal/BucketClient";
import {
  ReadBucket,
  ReadBucketBinding,
  makeReadBucketClient,
  readBucketOperations,
  type ReadBucketClient,
} from "@/Prisma/ReadBucket";
import {
  ReadWriteBucket,
  ReadWriteBucketBinding,
  type ReadWriteBucketClient,
} from "@/Prisma/ReadWriteBucket";
import {
  WriteBucket,
  WriteBucketBinding,
  writeBucketOperations,
  type WriteBucketClient,
} from "@/Prisma/WriteBucket";
import * as Output from "@/Output";
import { RuntimeContext } from "@/RuntimeContext";
import { Self } from "@/Self";
import { Stack, type StackSpec } from "@/Stack";
import { Stage } from "@/Stage";
import { Credentials, Endpoint, Region } from "@distilled.cloud/aws";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// The access-level split is a type-level contract first: a Read client must
// not offer a way to write, and a Write client must not offer a way to read.
type _ReadHasNoWrites = Expect<
  Equal<Extract<keyof ReadBucketClient, "put" | "delete">, never>
>;
type _WriteHasNoReads = Expect<
  Equal<Extract<keyof WriteBucketClient, "get" | "head" | "list">, never>
>;
type _ReadWriteHasBoth = Expect<
  Equal<Extract<keyof ReadWriteBucketClient, "get" | "put">, "get" | "put">
>;

const bucket = {
  Type: "Prisma.Bucket",
  LogicalId: "Uploads",
  FQN: "Api/Uploads",
} as PrismaBucket;

const emptyStack = (): Omit<StackSpec, "output"> => ({
  name: "prisma-bucket-binding-test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
});

/**
 * A host double that records the binding data instead of registering it on a
 * stack, matching the shape `Resource.bind` exposes.
 */
const recordingHost = <Data>(Type: string, LogicalId: string) => {
  const captured: Data[] = [];
  return {
    captured,
    host: {
      Type,
      LogicalId,
      FQN: LogicalId,
      bind: (...args: unknown[]) =>
        args[0] instanceof Array
          ? (data: Data) =>
              Effect.sync(() => {
                captured.push(data);
              })
          : Effect.void,
    },
  };
};

const bucketKeyDouble = () =>
  ({
    Type: "Prisma.BucketKey",
    LogicalId: "UploadsReadWriteBucketKey",
    FQN: "UploadsReadWriteBucketKey",
    endpoint: Output.asOutput("https://s3.prisma.test"),
    bucketName: Output.asOutput("user-1234"),
    accessKeyId: Output.asOutput("AKIAPRISMA"),
    secretAccessKey: Output.asOutput(Redacted.make("prisma-secret")),
  }) as unknown as PrismaBucketKey;

const runtimeDouble = () => {
  const stored: Record<string, Output.Output> = {};
  return {
    stored,
    runtime: {
      Type: "Prisma.Compute",
      id: "Api",
      env: stored,
      set: (id: string, output: Output.Output) =>
        Effect.sync(() => {
          const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
          stored[key] = output;
          return key;
        }),
      get: <T>(key: string): Effect.Effect<T> => {
        const output = stored[key];
        if (!output) return Effect.die(`missing runtime binding ${key}`);
        return Output.evaluate(output, {}) as Effect.Effect<T>;
      },
    },
  };
};

interface CapturedRequest {
  method: string;
  url: string;
  pathname: string;
  /**
   * Query parameters, read off the request's `urlParams` rather than its URL
   * string: the S3 client carries them there.
   */
  params: Record<string, string | string[]>;
  authorization: string | undefined;
  headers: Record<string, string>;
  body: string;
}

/**
 * A {@link BucketAccess} whose `authorize` runs the real distilled S3
 * operation against a stubbed transport, so request shaping and response
 * decoding are exercised without a socket.
 */
const stubbedAccess = (
  respond: (request: CapturedRequest) => Response,
): { access: BucketAccess; requests: CapturedRequest[] } => {
  const requests: CapturedRequest[] = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const body = request.body;
      const captured: CapturedRequest = {
        method: request.method,
        url: request.url,
        pathname: url.pathname,
        params: UrlParams.toRecord(request.urlParams),
        authorization: request.headers.authorization,
        headers: { ...request.headers },
        body:
          body._tag === "Uint8Array"
            ? new TextDecoder().decode(body.body)
            : body._tag === "Stream"
              ? yield* Stream.mkString(Stream.decodeText(body.stream)).pipe(
                  Effect.orDie,
                )
              : "",
      };
      requests.push(captured);
      return HttpClientResponse.fromWeb(request, respond(captured));
    }),
  );
  const context = Layer.mergeAll(
    Layer.succeed(
      Credentials.Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make("AKIAPRISMA"),
        secretAccessKey: Redacted.make("prisma-secret"),
        sessionToken: undefined,
      }),
    ),
    Layer.succeed(Region.Region, Effect.succeed(BUCKET_SIGNING_REGION)),
    Layer.succeed(Endpoint.Endpoint, Effect.succeed("https://s3.prisma.test")),
    Layer.succeed(HttpClient.HttpClient, client),
  );
  return {
    requests,
    access: {
      bucketName: Effect.succeed("user-1234"),
      authorize: (effect) => Effect.provide(effect, context),
      presign: () => Effect.die("presign is not stubbed"),
    },
  };
};

/**
 * The client operations declare a {@link RuntimeContext} requirement because
 * they read their credentials out of the host environment. The stubbed
 * transport supplies the credentials directly, so the tests only need the
 * service to be present.
 */
const withRuntime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) =>
  effect.pipe(
    Effect.provide(Layer.succeed(RuntimeContext, runtimeDouble().runtime)),
  );

const notFoundXml = (code: string) =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>missing</Message></Error>`,
    { status: 404, headers: { "content-type": "application/xml" } },
  );

describe("Prisma bucket binding identity", () => {
  it("derives capability-scoped env keys", () => {
    expect(
      bucketEnvKeys({ FQN: "Uploads", LogicalId: "Uploads" }, "Read"),
    ).toEqual({
      endpoint: "PRISMA_UPLOADS_READ_ENDPOINT",
      bucketName: "PRISMA_UPLOADS_READ_BUCKET_NAME",
      accessKeyId: "PRISMA_UPLOADS_READ_ACCESS_KEY_ID",
      secretAccessKey: "PRISMA_UPLOADS_READ_SECRET_ACCESS_KEY",
    });
    expect(
      bucketEnvKeys({ FQN: "Api/Uploads", LogicalId: "Uploads" }, "ReadWrite")
        .endpoint,
    ).toBe("PRISMA_API_UPLOADS_READ_WRITE_ENDPOINT");
    expect(
      bucketEnvKeys({ FQN: "Uploads", LogicalId: "Uploads" }, "Write").endpoint,
    ).toBe("PRISMA_UPLOADS_WRITE_ENDPOINT");
  });

  it("keeps each access level in its own env namespace", () => {
    const read = bucketEnvKeys(bucket, "Read");
    const write = bucketEnvKeys(bucket, "Write");
    const readWrite = bucketEnvKeys(bucket, "ReadWrite");

    expect(
      new Set([read.endpoint, write.endpoint, readWrite.endpoint]).size,
    ).toBe(3);
  });

  it("does not collide env keys after lossy normalization", () => {
    expect(
      bucketEnvKeys({ FQN: "up-loads", LogicalId: "up-loads" }, "Read")
        .accessKeyId,
    ).not.toBe(
      bucketEnvKeys({ FQN: "up_loads", LogicalId: "up_loads" }, "Read")
        .accessKeyId,
    );
  });

  it("derives a stable bucket key logical id per bucket and access level", () => {
    expect(bucketKeyLogicalId(bucket, "Read")).toBe("UploadsReadBucketKey");
    expect(bucketKeyLogicalId(bucket, "Write")).toBe("UploadsWriteBucketKey");
    expect(bucketKeyLogicalId(bucket, "ReadWrite")).toBe(
      "UploadsReadWriteBucketKey",
    );
    // Stable across calls: the deployed bundle has to derive the same id.
    expect(bucketKeyLogicalId(bucket, "Read")).toBe(
      bucketKeyLogicalId({ LogicalId: "Uploads" }, "Read"),
    );
  });
});

describe("Prisma bucket binding provisioning", () => {
  it.effect("creates a read-scoped bucket key and binds its env", () => {
    const stack = emptyStack();
    const { captured, host } = recordingHost<{
      env?: Record<string, Output.Output>;
    }>("Prisma.Compute", "Api");

    return Effect.gen(function* () {
      yield* ReadBucket(bucket);

      const key = stack.resources[bucketKeyLogicalId(bucket, "Read")];
      expect(key?.Type).toBe("Prisma.BucketKey");
      expect(key?.Props).toEqual({ bucket, role: "read" });

      const keys = bucketEnvKeys(bucket, "Read");
      expect(Object.keys(captured[0]?.env ?? {}).sort()).toEqual(
        [
          keys.accessKeyId,
          keys.bucketName,
          keys.endpoint,
          keys.secretAccessKey,
        ].sort(),
      );
    }).pipe(
      Effect.provide(ReadBucketBinding),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("reuses one bucket key across repeated binds", () => {
    const stack = emptyStack();
    const { host } = recordingHost("Prisma.Compute", "Api");

    return Effect.gen(function* () {
      yield* ReadWriteBucket(bucket);
      yield* ReadWriteBucket(bucket);

      expect(
        Object.keys(stack.resources).filter((id) => id.endsWith("BucketKey")),
      ).toEqual(["UploadsReadWriteBucketKey"]);
      expect(stack.resources["UploadsReadWriteBucketKey"]?.Props).toEqual({
        bucket,
        role: "read_write",
      });
    }).pipe(
      Effect.provide(ReadWriteBucketBinding),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("mints separate keys for separate access levels", () => {
    const stack = emptyStack();
    const { host } = recordingHost("Prisma.Compute", "Api");

    return Effect.gen(function* () {
      yield* ReadBucket(bucket);
      yield* WriteBucket(bucket);

      expect(
        Object.keys(stack.resources)
          .filter((id) => id.endsWith("BucketKey"))
          .sort(),
      ).toEqual(["UploadsReadBucketKey", "UploadsWriteBucketKey"]);
      expect(stack.resources["UploadsReadBucketKey"]?.Props).toEqual({
        bucket,
        role: "read",
      });
      // No write-only role exists yet, so the write key is read_write.
      expect(stack.resources["UploadsWriteBucketKey"]?.Props).toEqual({
        bucket,
        role: "read_write",
      });
    }).pipe(
      Effect.provide(ReadBucketBinding),
      Effect.provide(WriteBucketBinding),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("binds Cloudflare Workers as text bindings", () => {
    const stack = emptyStack();
    const { captured, host } = recordingHost<{
      bindings?: Output.Output[];
    }>("Cloudflare.Worker", "Api");

    return Effect.gen(function* () {
      yield* ReadWriteBucket(bucket);

      expect(captured[0]?.bindings?.length).toBe(4);
    }).pipe(
      Effect.provide(ReadWriteBucketBinding),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("dies on a host that carries no bindings", () => {
    const stack = emptyStack();
    const { host } = recordingHost("Cloudflare.Container", "Api");

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(ReadBucket(bucket));

      expect(String(exit)).toContain("Prisma.ReadBucket supports");
      expect(String(exit)).toContain("Cloudflare.Container");
    }).pipe(
      Effect.provide(ReadBucketBinding),
      Effect.provide(Layer.succeed(Self, host)),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, "test"),
    );
  });

  it.effect("does not require the deploy-time host at runtime", () => {
    const stack = emptyStack();
    const { runtime } = runtimeDouble();

    // Bundles fold `__ALCHEMY_RUNTIME__` to `true`; simulate that so the
    // deploy-time host dispatch is skipped and no Self is needed.
    const wasRuntime = globalThis.__ALCHEMY_RUNTIME__;
    globalThis.__ALCHEMY_RUNTIME__ = true;
    return Effect.gen(function* () {
      const uploads = yield* ReadWriteBucket(bucket);

      expect(typeof uploads.get).toBe("function");
      expect(typeof uploads.put).toBe("function");
    }).pipe(
      Effect.provide(ReadWriteBucketBinding),
      Effect.provide(Layer.succeed(RuntimeContext, runtime)),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, "test"),
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.__ALCHEMY_RUNTIME__ = wasRuntime;
        }),
      ),
    );
  });
});

describe("Prisma bucket binding runtime credentials", () => {
  it.effect("round-trips the bucket key through the host environment", () => {
    const { runtime, stored } = runtimeDouble();
    const keys = bucketEnvKeys(bucket, "ReadWrite");
    const credentials = bucketCredentials(keys, bucketKeyDouble());

    return Effect.gen(function* () {
      expect(yield* credentials.endpoint).toBe("https://s3.prisma.test");
      expect(yield* credentials.bucketName).toBe("user-1234");
      expect(yield* credentials.accessKeyId).toBe("AKIAPRISMA");
      expect(Redacted.value(yield* credentials.secretAccessKey)).toBe(
        "prisma-secret",
      );
      expect(Object.keys(stored).sort()).toEqual(
        [
          keys.accessKeyId,
          keys.bucketName,
          keys.endpoint,
          keys.secretAccessKey,
        ].sort(),
      );
    }).pipe(Effect.provide(Layer.succeed(RuntimeContext, runtime)));
  });
});

describe("Prisma bucket client", () => {
  it.effect("reads an object body", () => {
    const { access, requests } = stubbedAccess(
      () =>
        new Response("hello", {
          status: 200,
          headers: {
            ETag: '"abc123"',
            "content-type": "text/plain",
            "content-length": "5",
          },
        }),
    );

    return Effect.gen(function* () {
      const object = yield* readBucketOperations(access).get("reports/a.txt");

      expect(object?.key).toBe("reports/a.txt");
      expect(object?.etag).toBe("abc123");
      expect(object?.contentType).toBe("text/plain");
      expect(yield* object!.text()).toBe("hello");
      // A custom endpoint means path-style addressing: /{bucket}/{key}. The
      // separators inside the key are percent-encoded, which S3-compatible
      // stores decode back to the same key.
      expect(requests[0]?.pathname).toBe("/user-1234/reports%2Fa.txt");
      expect(requests[0]?.authorization).toContain("AWS4-HMAC-SHA256");
      expect(requests[0]?.authorization).toContain(
        `/${BUCKET_SIGNING_REGION}/s3/aws4_request`,
      );
    }).pipe(withRuntime);
  });

  it.effect("resolves null for a missing key", () =>
    Effect.gen(function* () {
      const read = readBucketOperations(
        stubbedAccess(() => notFoundXml("NoSuchKey")).access,
      );
      expect(yield* read.get("missing")).toBeNull();

      const head = readBucketOperations(
        stubbedAccess(() => notFoundXml("NotFound")).access,
      );
      expect(yield* head.head("missing")).toBeNull();
    }).pipe(withRuntime),
  );

  it.effect("lists objects and reports the continuation cursor", () => {
    const { access, requests } = stubbedAccess(
      () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>user-1234</Name>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>page-2</NextContinuationToken>
  <Contents><Key>a.txt</Key><Size>5</Size><ETag>&quot;abc&quot;</ETag></Contents>
  <Contents><Key>b.txt</Key><Size>7</Size><ETag>&quot;def&quot;</ETag></Contents>
  <CommonPrefixes><Prefix>logs/</Prefix></CommonPrefixes>
</ListBucketResult>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
    );

    return Effect.gen(function* () {
      const result = yield* readBucketOperations(access).list({
        prefix: "reports/",
        delimiter: "/",
        limit: 2,
      });

      expect(result.objects.map((object) => object.key)).toEqual([
        "a.txt",
        "b.txt",
      ]);
      expect(result.objects[0]?.etag).toBe("abc");
      expect(result.delimitedPrefixes).toEqual(["logs/"]);
      expect(result.truncated).toBe(true);
      expect(result.cursor).toBe("page-2");
      expect(requests[0]?.params["list-type"]).toBe("2");
      expect(requests[0]?.params["prefix"]).toBe("reports/");
      expect(requests[0]?.params["delimiter"]).toBe("/");
      expect(requests[0]?.params["max-keys"]).toBe("2");
    }).pipe(withRuntime);
  });

  it.effect("writes an object", () => {
    const { access, requests } = stubbedAccess(
      () => new Response("", { status: 200, headers: { ETag: '"put-etag"' } }),
    );

    return Effect.gen(function* () {
      const object = yield* writeBucketOperations(access).put(
        "reports/a.json",
        '{"ok":true}',
        { contentType: "application/json", metadata: { owner: "api" } },
      );

      expect(object.etag).toBe("put-etag");
      expect(object.metadata).toEqual({ owner: "api" });
      expect(requests[0]?.method).toBe("PUT");
      expect(requests[0]?.pathname).toBe("/user-1234/reports%2Fa.json");
      expect(requests[0]?.body).toBe('{"ok":true}');
      expect(requests[0]?.headers["x-amz-meta-owner"]).toBe("api");
    }).pipe(withRuntime);
  });

  it.effect("deletes every requested key", () => {
    const { access, requests } = stubbedAccess(
      () => new Response("", { status: 204 }),
    );

    return Effect.gen(function* () {
      yield* writeBucketOperations(access).delete(["a.txt", "b.txt"]);

      expect(requests.map((request) => request.method)).toEqual([
        "DELETE",
        "DELETE",
      ]);
      expect(requests.map((request) => request.pathname).sort()).toEqual([
        "/user-1234/a.txt",
        "/user-1234/b.txt",
      ]);
    }).pipe(withRuntime);
  });

  it.effect("presigns path-style URLs against the bucket endpoint", () => {
    const { runtime } = runtimeDouble();
    const keys = bucketEnvKeys(bucket, "ReadWrite");
    const client = makeReadBucketClient(
      bucketCredentials(keys, bucketKeyDouble()),
    );

    return Effect.gen(function* () {
      const url = new URL(
        yield* client.presignGet("reports/a.txt", { expiresIn: 60 }),
      );

      expect(url.origin).toBe("https://s3.prisma.test");
      expect(url.pathname).toBe("/user-1234/reports/a.txt");
      expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
      expect(url.searchParams.get("X-Amz-Credential")).toContain(
        `/${BUCKET_SIGNING_REGION}/s3/aws4_request`,
      );
    }).pipe(Effect.provide(Layer.succeed(RuntimeContext, runtime)));
  });

  it("exposes no write operations on the read client", () => {
    const client = readBucketOperations(
      stubbedAccess(() => new Response("", { status: 200 })).access,
    );

    expect(Object.keys(client).sort()).toEqual([
      "get",
      "head",
      "list",
      "presignGet",
    ]);
  });
});
