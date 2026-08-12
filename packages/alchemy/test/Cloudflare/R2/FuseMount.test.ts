/**
 * `FUSE.Mount` (R2 via tigrisfs) against a REAL container: the guest mounts
 * the stack's R2 bucket at `/persist` via tigrisfs during init, and
 * every assertion drives plain file physics against the mountpoint
 * over Worker → Durable Object → container RPC.
 *
 * What only this suite can prove: the minted token's derived S3
 * credentials authenticate against the account's S3 endpoint, the
 * mount becomes ready before the guest serves, writes through the
 * filesystem land as real R2 objects (verified out-of-band via
 * distilled), and objects written through the R2 API are readable
 * through the filesystem.
 */
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "./fixtures/fuse-mount/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// image build + push + worker/DO deploy comfortably exceeds the default
// hook budget
const HOOK_TIMEOUT = 900_000;

const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

type Envelope<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/**
 * Call one operation on the deployed container, retrying through
 * fresh-deploy propagation AND container cold start (the first call
 * boots the instance and performs the mount, which can take a while).
 */
const op = <A>(
  url: string,
  operation: string,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<A, never, HttpClient.HttpClient> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({ op: operation, args }),
        ),
      ),
    ),
    Effect.flatMap((res) =>
      res.status === 200
        ? (res.json as Effect.Effect<unknown>)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new NotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is NotReady => e instanceof NotReady,
      schedule: Schedule.min([
        Schedule.exponential("1 second"),
        Schedule.spaced("5 seconds"),
      ]),
      times: 60,
    }),
    Effect.map((value) => value as A),
    Effect.orDie,
  );

/** Unwrap a successful envelope, failing the test with the error text. */
const value = <A>(envelope: Envelope<A>): A => {
  if (!envelope.ok) {
    throw new Error(`fuse operation failed: ${envelope.error}`);
  }
  return envelope.value;
};

class ObjectLagError extends Data.TaggedError("ObjectLagError")<{}> {}

// `test.provider` (scratch unused) provides the distilled Cloudflare
// context for the out-of-band verification calls; the deployed stack
// still comes from the shared `beforeAll` handle.
test.provider(
  "writes through the FUSE mount land as real R2 objects",
  () =>
    Effect.gen(function* () {
      const { url, bucketName } = yield* stack;
      const { accountId } = yield* yield* CloudflareEnvironment;

      // the mount is where we asked for it
      expect(yield* op<string>(url, "mountPath")).toBe("/persist");

      // write + read back THROUGH the filesystem
      value(
        yield* op<Envelope<void>>(url, "write", "hello.txt", "from the mount"),
      );
      expect(value(yield* op<Envelope<string>>(url, "read", "hello.txt"))).toBe(
        "from the mount",
      );
      expect(
        value(yield* op<Envelope<ReadonlyArray<string>>>(url, "list")),
      ).toContain("hello.txt");

      // the write is a REAL R2 object — verify out-of-band via distilled
      // (tigrisfs flushes on close; allow brief eventual consistency)
      const text = yield* r2
        .getObject({ accountId, bucketName, objectName: "hello.txt" })
        .pipe(
          Effect.flatMap((object) =>
            object.body.pipe(Stream.decodeText, Stream.mkString),
          ),
          Effect.retry({
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );
      expect(text).toBe("from the mount");
    }),
  { timeout: 600_000 },
);

test.provider(
  "objects written through the R2 API are readable through the mount",
  () =>
    Effect.gen(function* () {
      const { url, bucketName } = yield* stack;
      const { accountId } = yield* yield* CloudflareEnvironment;

      // make sure the container is up (and the mount ready) FIRST, so the
      // seed object is created after mount — a fresh lookup, no negative
      // cache to fight
      expect(yield* op<string>(url, "mountPath")).toBe("/persist");

      yield* r2.putObject({
        accountId,
        bucketName,
        objectName: "seed.txt",
        contentType: "text/plain",
        body: new Blob(["seeded via api"], { type: "text/plain" }),
      });

      // reads go through tigrisfs' lookup; retry through its attr caches
      const seeded = yield* op<Envelope<string>>(url, "read", "seed.txt").pipe(
        Effect.flatMap((envelope) =>
          envelope.ok
            ? Effect.succeed(envelope.value)
            : Effect.fail(new ObjectLagError()),
        ),
        Effect.retry({
          while: (e): e is ObjectLagError => e instanceof ObjectLagError,
          schedule: Schedule.spaced("2 seconds"),
          times: 30,
        }),
      );
      expect(seeded).toBe("seeded via api");
    }),
  { timeout: 600_000 },
);
