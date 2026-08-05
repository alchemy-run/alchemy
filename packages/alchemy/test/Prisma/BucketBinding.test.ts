import { bucketEnvKeys, bucketKeyLogicalId } from "@/Prisma/BucketBinding";
import type { Bucket as PrismaBucket } from "@/Prisma/Bucket";
import type { ReadBucketClient } from "@/Prisma/ReadBucket";
import type { ReadWriteBucketClient } from "@/Prisma/ReadWriteBucket";
import type { WriteBucketClient } from "@/Prisma/WriteBucket";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import Stack from "./fixtures/stack.ts";

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

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Prisma.providers(),
});

const wantsLive = process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS === "true";
const hasLiveCredentials =
  !!process.env.PRISMA_SERVICE_TOKEN?.trim() ||
  !!process.env.PRISMA_API_TOKEN?.trim() ||
  process.env.ALCHEMY_RUN_LIVE_PRISMA_WITH_PROFILE === "true";
const runLive = wantsLive && hasLiveCredentials;

const HOOK_TIMEOUT = 600_000;
const TEST_TIMEOUT = 120_000;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

if (wantsLive && !hasLiveCredentials) {
  test(
    "requires Prisma credentials for the live bucket binding suite",
    Effect.fail(
      new Error(
        [
          "Live Prisma bucket binding suite requested but no credentials are configured.",
          "Set PRISMA_SERVICE_TOKEN, set PRISMA_API_TOKEN, or run `alchemy login --configure` and select `Service Token`,",
          "then rerun this live test with ALCHEMY_RUN_LIVE_PRISMA_TESTS=true.",
        ].join(" "),
      ),
    ),
  );
}

class AppNotReady extends Data.TaggedError("AppNotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — caps total wait so a genuine failure surfaces
// fast instead of an uncapped exponential blowing past the test timeout
// while riding out cold-start propagation.
const ready = Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]);

/** Retry an HTTP call until it returns 200 (rides out cold-start 404s). */
const untilOk = <E, R>(
  eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new AppNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is AppNotReady => e instanceof AppNotReady,
      schedule: ready,
    }),
  );

class ValueMismatch extends Data.TaggedError("ValueMismatch")<{
  expected: string;
  actual: string | null;
}> {}

const retryMismatch = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  eff.pipe(
    Effect.retry({
      while: (e: E) => e instanceof ValueMismatch,
      schedule: ready,
    }),
  );

/** GET `${base}/get?key=` and retry until the value matches (read-after-write propagation). */
const expectValue = (base: string, key: string, expected: string) =>
  untilOk(HttpClient.get(`${base}/get?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const actual = (body as { value: string | null }).value;
      return actual === expected
        ? Effect.succeed(actual)
        : Effect.fail(new ValueMismatch({ expected, actual }));
    }),
    retryMismatch,
  );

/** GET `/get` and retry until the object is gone (`value === null`). */
const expectMissing = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/get?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const actual = (body as { value: string | null }).value;
      return actual === null
        ? Effect.succeed(null)
        : Effect.fail(new ValueMismatch({ expected: "<missing>", actual }));
    }),
    retryMismatch,
  );

/** HEAD-equivalent: `/head` returns `{ exists, size }` (metadata only, no body). */
const headObject = (base: string, key: string) =>
  untilOk(HttpClient.get(`${base}/head?key=${encodeURIComponent(key)}`)).pipe(
    Effect.flatMap((res) => res.json),
    Effect.map((body) => body as { exists: boolean; size: number | null }),
  );

/** `/list?prefix=` and retry until `key` appears (list is eventually consistent). */
const expectListed = (base: string, prefix: string, key: string) =>
  untilOk(
    HttpClient.get(`${base}/list?prefix=${encodeURIComponent(prefix)}`),
  ).pipe(
    Effect.flatMap((res) => res.json),
    Effect.flatMap((body) => {
      const keys = (body as { keys: string[] }).keys;
      return keys.includes(key)
        ? Effect.succeed(keys)
        : Effect.fail(
            new ValueMismatch({ expected: key, actual: keys.join(",") }),
          );
    }),
    retryMismatch,
  );

const put = (base: string, key: string, value: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.put(`${base}/put?key=${encodeURIComponent(key)}`).pipe(
        HttpClientRequest.bodyText(value),
      ),
    ),
  );

const del = (base: string, key: string) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(
        `${base}/del?key=${encodeURIComponent(key)}`,
      ),
    ),
  );

const delMany = (base: string, keys: string[]) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.make("DELETE")(
        `${base}/del-many?keys=${encodeURIComponent(keys.join(","))}`,
      ),
    ),
  );

/**
 * Drive every client method through `fetch`: `put` → `get` → `head` →
 * `list` → `delete` (single) → `delete` (batch), reading back through
 * `readBase` and writing through `writeBase`. All apps share one bucket, so
 * keys are namespaced by `label` to keep the runs independent.
 */
const exercise = (label: string, writeBase: string, readBase: string) =>
  Effect.gen(function* () {
    const prefix = `${label}/`;
    const k1 = `${prefix}k1`;
    const v1 = `${label}-value`;

    // put + get (read-after-write)
    expect((yield* put(writeBase, k1, v1)).status).toBe(200);
    expect(yield* expectValue(readBase, k1, v1)).toBe(v1);

    // head — metadata reflects the written object
    const meta = yield* headObject(readBase, k1);
    expect(meta.exists).toBe(true);
    expect(meta.size).toBe(new TextEncoder().encode(v1).length);

    // list — the key shows up under its prefix
    expect(yield* expectListed(readBase, prefix, k1)).toContain(k1);

    // delete (single) — head/get then report it gone
    yield* del(writeBase, k1);
    yield* expectMissing(readBase, k1);
    expect((yield* headObject(readBase, k1)).exists).toBe(false);

    // delete (batch) — write two, delete both in one call
    const k2 = `${prefix}k2`;
    const k3 = `${prefix}k3`;
    yield* put(writeBase, k2, "v2");
    yield* put(writeBase, k3, "v3");
    expect(yield* expectValue(readBase, k2, "v2")).toBe("v2");
    yield* delMany(writeBase, [k2, k3]);
    yield* expectMissing(readBase, k2);
    yield* expectMissing(readBase, k3);
  });

/**
 * Deploys three Prisma Compute apps that all bind one shared Object Store
 * bucket — read / write / read-write over the native Compute binding — via
 * {@link Stack}, then drives the binding over `fetch`:
 *
 * - write through the Write app, read it back through the Read app
 *   (cross-app, proving both halves agree on the bucket);
 * - round-trip a key through the ReadWrite app by itself.
 *
 * The stack lives in `fixtures/stack.ts` so it can also be inspected
 * directly, e.g. `alchemy tail --stage test ./test/Prisma/fixtures/stack.ts`.
 */
describe.skipIf(!runLive)("Prisma bucket binding over Prisma Compute", () => {
  const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "write + read across separate compute apps",
    Effect.gen(function* () {
      const out = yield* stack;
      yield* exercise("bind", out.write, out.read);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "read-write round-trip in one compute app",
    Effect.gen(function* () {
      const out = yield* stack;
      yield* exercise("rw-bind", out.readWrite, out.readWrite);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
