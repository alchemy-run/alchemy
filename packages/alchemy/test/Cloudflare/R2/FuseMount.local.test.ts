/**
 * `FUSE.Mount` (R2 via tigrisfs) under `alchemy dev` — the FULL local
 * topology: the bucket is the local simulator (`dev:` id, no cloud),
 * the container is a real docker container created through the dev
 * Docker interceptor (which grants the FUSE device/capability and
 * injects the dev S3 gateway's URL), and tigrisfs mounts the simulator
 * through the gateway.
 *
 * What only this suite can prove: the marker-scoped Docker injection
 * fires, tigrisfs authenticates/mounts against the gateway's S3 façade,
 * and — the money assertion — the FUSE mount and the worker's native
 * `r2_bucket` binding share ONE local data plane.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "./fixtures/fuse-mount/local-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// first run builds the sandbox image (apt + tigrisfs) locally
const HOOK_TIMEOUT = 600_000;

const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {
  override get message() {
    return `${this.status}: ${this.body}`;
  }
}

type Envelope<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

/**
 * Call one operation on the dev container, retrying through container
 * cold start (the first call docker-creates the instance and performs
 * the FUSE mount).
 */
const op = <A>(
  url: string,
  operation: string,
  ...args: ReadonlyArray<unknown>
): Effect.Effect<A, never, HttpClient.HttpClient> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.post(new URL("/", url).href).pipe(
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
      // local cold start = docker create + tigrisfs mount, ~seconds when
      // healthy — a couple of minutes of patience, then fail LOUD with
      // the last status/body instead of eating the test timeout
      times: 24,
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

test(
  "the FUSE mount and the worker binding share the local simulator",
  Effect.gen(function* () {
    const { url, bucketName } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // the local provider fabricated the bucket — no cloud call ran —
    // and the worker serves from the local dev proxy
    expect(bucketName).toMatch(/^dev:/);
    expect(url).toMatch(/^http:\/\/localhost:\d+/);

    // boot the container + mount; prove the mountpoint
    expect(yield* op<string>(url, "mountPath")).toBe("/persist");

    // write THROUGH the filesystem, read back through the filesystem
    value(
      yield* op<Envelope<void>>(url, "write", "from-fuse.txt", "via mount"),
    );
    expect(
      value(yield* op<Envelope<string>>(url, "read", "from-fuse.txt")),
    ).toBe("via mount");
    expect(
      value(yield* op<Envelope<ReadonlyArray<string>>>(url, "list")),
    ).toContain("from-fuse.txt");

    // the money assertion: the file IS an object in the local simulator,
    // visible through the worker's NATIVE r2_bucket binding
    const viaBinding = (yield* client
      .get(new URL("/object?key=from-fuse.txt", url).href)
      .pipe(
        Effect.flatMap((res) => res.json),
        Effect.orDie,
      )) as { text: string | null };
    expect(viaBinding.text).toBe("via mount");

    // and the reverse: an object written through the binding is a file
    // the mount can read (retry through tigrisfs' attribute caches)
    yield* client
      .execute(
        HttpClientRequest.post(
          new URL("/object?key=from-binding.txt", url).href,
        ).pipe(HttpClientRequest.bodyText("via binding")),
      )
      .pipe(Effect.orDie);
    const seeded = yield* op<Envelope<string>>(
      url,
      "read",
      "from-binding.txt",
    ).pipe(
      Effect.flatMap((envelope) =>
        envelope.ok
          ? Effect.succeed(envelope.value)
          : Effect.fail(new NotReady({ status: 0, body: envelope.error })),
      ),
      Effect.retry({
        while: (e): e is NotReady => e instanceof NotReady,
        schedule: Schedule.spaced("2 seconds"),
        times: 15,
      }),
      Effect.orDie,
    );
    expect(seeded).toBe("via binding");
  }).pipe(logLevel),
  // a failure inside is a bug to read, not to re-run: retries would
  // just multiply the (already bounded) in-test polling
  { timeout: 240_000, retry: 0 },
);
