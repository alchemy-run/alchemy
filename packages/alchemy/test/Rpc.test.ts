import { describe, expect, it } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { safeHttpEffect } from "@/Http";
import * as Rpc from "@/Rpc";

// ---------------------------------------------------------------------------
// In-memory loopback: the server `serveRpc` handler is turned into a Web
// `Request` handler and injected as the `fetch` implementation behind the
// real `FetchHttpClient`. This exercises the full wire protocol (headers,
// JSON bodies, streamed NDJSON / raw bytes) with zero sockets and zero
// container — just the protocol round-tripping in process.
// ---------------------------------------------------------------------------

class BoomError extends Data.TaggedError("BoomError")<{
  readonly code: number;
}> {}

// The fallback handler stands in for the user's non-RPC routes.
const fallback = Effect.succeed(HttpServerResponse.text("fallback", { status: 200 }));

const withRpc = <A, E>(
  shape: Record<string, unknown>,
  use: (stub: any) => Effect.Effect<A, E, any>,
): Effect.Effect<A, E> => {
  const webHandler = HttpEffect.toWebHandler(safeHttpEffect(Rpc.serveRpc(shape, fallback)));
  const fetchImpl = ((url: any, init?: any) =>
    webHandler(new Request(url, init))) as typeof globalThis.fetch;

  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const stub = Rpc.makeFetchRpcStub<any>({
      fetch: (request) => client.execute(request),
      baseUrl: "http://rpc",
    });
    return yield* use(stub);
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetchImpl),
  ) as Effect.Effect<A, E>;
};

const shape = {
  ping: () => Effect.succeed("pong"),
  echo: (a: string, b: number) => Effect.succeed({ a, b }),
  maybe: (key: string) => Effect.succeed(key === "present" ? "value" : null),
  identity: (value: unknown) => Effect.succeed(value),
  boomTagged: () => Effect.fail(new BoomError({ code: 42 })),
  boomPlain: () => Effect.fail(new Error("plain boom")),
  countJsonl: (n: number) => Stream.range(1, n).pipe(Stream.map((i) => ({ i }))),
  emptyStream: () => Stream.empty,
  // An INFINITE source: only a truly streaming (lazily-pulled) transport can
  // return a finite prefix of this. A buffer-then-stringify implementation
  // would try to realize the whole stream and never produce a result.
  infinite: () => Stream.iterate(0, (n) => n + 1),
  bytes: () => Stream.fromIterable([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]),
  failingStream: () =>
    Stream.range(1, 2).pipe(
      Stream.map((i) => ({ i })),
      Stream.concat(Stream.fail(new BoomError({ code: 7 }))),
    ),
};

describe("Rpc fetch protocol", { tags: ["unit", "local"] }, () => {
  describe("value methods (Effect)", () => {
    it.effect("returns a primitive value", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          expect(yield* stub.ping()).toBe("pong");
        }),
      ),
    );

    it.effect("round-trips arguments and an object result", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          expect(yield* stub.echo("hi", 7)).toEqual({ a: "hi", b: 7 });
        }),
      ),
    );

    it.effect("supports a null result", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          expect(yield* stub.maybe("absent")).toBe(null);
          expect(yield* stub.maybe("present")).toBe("value");
        }),
      ),
    );

    it.effect("round-trips nested/array/null argument shapes", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const value = { a: [1, 2, { b: "x" }], c: null, d: true };
          expect(yield* stub.identity(value)).toEqual(value);
        }),
      ),
    );

    it.effect("is usable as an Effect via .pipe (orDie)", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          expect(yield* stub.ping().pipe(Effect.orDie)).toBe("pong");
        }),
      ),
    );
  });

  describe("error channel", () => {
    it.effect("lifts a remote tagged failure into the error channel", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const error = (yield* stub.boomTagged().pipe(Effect.flip)) as {
            _tag: string;
            code: number;
          };
          expect(error._tag).toBe("BoomError");
          expect(error.code).toBe(42);
        }),
      ),
    );

    it.effect("lifts a remote plain Error into the error channel", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const error = (yield* stub.boomPlain().pipe(Effect.flip)) as {
            name: string;
            message: string;
          };
          expect(error.message).toBe("plain boom");
        }),
      ),
    );

    it.effect("fails an unknown method (404 → RpcCallError)", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const error = (yield* stub.doesNotExist().pipe(Effect.flip)) as {
            _tag: string;
          };
          expect(error._tag).toBe("RpcCallError");
        }),
      ),
    );
  });

  describe("method lookup", () => {
    it.effect("never dispatches Object.prototype members", () =>
      Effect.gen(function* () {
        const webHandler = HttpEffect.toWebHandler(safeHttpEffect(Rpc.serveRpc(shape, fallback)));
        for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
          const response = yield* Effect.promise(() =>
            webHandler(
              new Request(`http://rpc${Rpc.RPC_PATH_PREFIX}${name}`, {
                method: "POST",
                body: "[]",
              }),
            ),
          );
          expect(response.status).toBe(404);
        }
      }),
    );
  });

  describe("streaming methods (Stream)", () => {
    const collect = <T>(streamLike: any) =>
      Effect.gen(function* () {
        const out: T[] = [];
        yield* Stream.runForEach(streamLike, (v: T) =>
          Effect.sync(() => {
            out.push(v);
          }),
        );
        return out;
      });

    it.effect("round-trips an NDJSON object stream", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const items = yield* collect(stub.countJsonl(3));
          expect(items).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
        }),
      ),
    );

    it.effect("handles an empty stream", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          expect(yield* collect(stub.emptyStream())).toEqual([]);
        }),
      ),
    );

    it.effect("round-trips a raw byte stream (content preserved)", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const chunks = yield* collect<Uint8Array>(stub.bytes());
          const flat = chunks.flatMap((c) => Array.from(c));
          expect(flat).toEqual([1, 2, 3, 4, 5]);
        }),
      ),
    );

    it.effect("consumes an infinite stream incrementally (not buffered)", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          // If the server buffered + stringified the whole stream before
          // responding, an infinite source would never produce a result and
          // this would hit the timeout below. Taking a finite prefix only
          // succeeds because the body is pulled lazily, element by element.
          const out = yield* collect<number>(stub.infinite().pipe(Stream.take(5)));
          expect(out).toEqual([0, 1, 2, 3, 4]);
        }),
      ).pipe(Effect.timeout("15 seconds")),
    );

    it.effect("server stops producing once the client stops consuming (backpressure)", () =>
      Effect.gen(function* () {
        // The shape runs in-process, so this closure-captured array sees
        // exactly how far the server stream was pulled.
        const produced: number[] = [];
        const localShape = {
          counter: () =>
            Stream.iterate(0, (n) => n + 1).pipe(
              Stream.tap((n) => Effect.sync(() => produced.push(n))),
            ),
        };

        const out = yield* withRpc(localShape, (stub) =>
          collect<number>(stub.counter().pipe(Stream.take(3))),
        ).pipe(Effect.timeout("15 seconds"));

        expect(out).toEqual([0, 1, 2]);
        // The client only consumed 3 elements. A streaming transport pulls
        // lazily under backpressure, so the server produces the consumed
        // prefix plus at most a bounded buffer — never the infinite tail a
        // buffer-then-stringify implementation would.
        expect(produced.length).toBeGreaterThanOrEqual(3);
        expect(produced.length).toBeLessThan(10_000);
      }),
    );

    it.effect("lifts a mid-stream failure into RpcRemoteStreamError", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const result = yield* stub.failingStream().pipe(Stream.runCollect, Effect.flip);
          expect((result as { _tag: string })._tag).toBe("RpcRemoteStreamError");
          const error = (result as { error: { _tag: string; code: number } }).error;
          expect(error._tag).toBe("BoomError");
          expect(error.code).toBe(7);
        }),
      ),
    );

    it.effect("delivers values before a mid-stream failure", () =>
      withRpc(shape, (stub) =>
        Effect.gen(function* () {
          const seen: Array<{ i: number }> = [];
          yield* stub.failingStream().pipe(
            Stream.runForEach((v: { i: number }) =>
              Effect.sync(() => {
                seen.push(v);
              }),
            ),
            Effect.flip,
          );
          expect(seen).toEqual([{ i: 1 }, { i: 2 }]);
        }),
      ),
    );
  });

  describe("fallback routing", () => {
    it.effect("non-RPC requests fall through to the fallback handler", () =>
      Effect.gen(function* () {
        const webHandler = HttpEffect.toWebHandler(safeHttpEffect(Rpc.serveRpc(shape, fallback)));
        const res = yield* Effect.promise(() => webHandler(new Request("http://rpc/not-rpc")));
        expect(res.status).toBe(200);
        expect(yield* Effect.promise(() => res.text())).toBe("fallback");
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Nested RPC: a shape method that *forwards* another RPC call returns an
  // `asEffectOrStream` value — an `Effect` that is ALSO branded as a `Stream`
  // so a single return is usable either way. This is exactly the shape of a
  // Worker→DO→Container chain (e.g. `readObjectRpc: (k) => container.readObject(k)`).
  // The dispatcher MUST run it as an effect rather than mis-detecting the
  // brand and serving it as a stream envelope (which decodes to `{channel:{}}`
  // on the caller). See `serveRpc` and the Worker/DO bridges.
  // -------------------------------------------------------------------------
  describe("nested RPC (asEffectOrStream forwarding)", () => {
    const nested = {
      // value method forwarding a nested call that resolves to a value
      forwardValue: (k: string) => Rpc.asEffectOrStream(Effect.succeed(`deep:${k}`)),
      // value method forwarding a nested call that resolves to a Stream
      forwardStream: (n: number) =>
        Rpc.asEffectOrStream(Effect.succeed(Stream.range(1, n).pipe(Stream.map((i) => ({ i }))))),
    };

    it.effect("a forwarded value round-trips as a value (not a Stream)", () =>
      withRpc(nested, (stub) =>
        Effect.gen(function* () {
          const value = yield* stub.forwardValue("x");
          expect(value).toBe("deep:x");
        }),
      ),
    );

    it.effect("a forwarded Stream round-trips as a Stream", () =>
      withRpc(nested, (stub) =>
        Effect.gen(function* () {
          const out: Array<{ i: number }> = [];
          yield* Stream.runForEach(stub.forwardStream(3), (v: { i: number }) =>
            Effect.sync(() => {
              out.push(v);
            }),
          );
          expect(out).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
        }),
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Benchmark: the loopback exercises the FULL wire protocol (serialize args →
  // serveRpc → JSON response → decode) with zero sockets and zero container,
  // so it isolates the RPC layer's per-call overhead from network latency.
  // This is the quantitative backstop for "RPC is not the bottleneck": a
  // catastrophic regression (accidental buffering, O(n)-per-call work, a real
  // socket sneaking in) blows the per-call ceiling, while normal network jitter
  // (the 400-700ms seen against a live container's R2 read) lives entirely
  // outside this measurement.
  // -------------------------------------------------------------------------
  describe("performance", () => {
    const N = 2_000;
    // In-process protocol overhead is sub-millisecond; a generous ceiling so
    // the assertion only trips on a real regression, never on a slow CI box.
    const MAX_MS_PER_CALL = 5;

    const benchmark = (
      label: string,
      stub: any,
      call: (stub: any) => Effect.Effect<unknown, unknown, any>,
      expected: unknown,
    ) =>
      Effect.gen(function* () {
        // Warm the JIT + connection-less path, and assert correctness once so
        // the timing loop below isn't measuring a broken (e.g. erroring) path.
        expect(yield* call(stub)).toEqual(expected);
        const start = yield* Effect.sync(() => performance.now());
        for (let i = 0; i < N; i++) {
          yield* call(stub);
        }
        const elapsed = yield* Effect.sync(() => performance.now() - start);
        const perCall = elapsed / N;
        yield* Effect.logInfo(
          `RPC ${label}: ${perCall.toFixed(4)} ms/call ` +
            `(${N} calls in ${elapsed.toFixed(0)} ms)`,
        );
        expect(perCall).toBeLessThan(MAX_MS_PER_CALL);
      });

    it.effect(
      "no-arg value-method RPC overhead stays sub-millisecond",
      () => withRpc(shape, (stub) => benchmark("ping", stub, (s) => s.ping(), "pong")),
      { timeout: 60_000 },
    );

    it.effect(
      "arg + object-result RPC overhead stays sub-millisecond",
      () =>
        withRpc(shape, (stub) =>
          benchmark("echo", stub, (s) => s.echo("hi", 7), { a: "hi", b: 7 }),
        ),
      { timeout: 60_000 },
    );
  });
});

describe("Rpc method addressing", { tags: ["unit", "local"] }, () => {
  it.effect("reads the method from the pathname only", () =>
    Effect.sync(() => {
      const of = (url: string) => Rpc.rpcMethodOf({ url });
      expect(of("https://worker/__rpc__/increment")).toBe("increment");
      expect(of("/__rpc__/increment?x=1#top")).toBe("increment");
      expect(of("/base/__rpc__/get%20all")).toBe("get all");
      expect(of("/__rpc__/")).toBe("");
      expect(of("https://worker/page?next=/__rpc__/increment")).toBeUndefined();
      expect(of("https://worker/page#/__rpc__/increment")).toBeUndefined();
      expect(of("https://worker/")).toBeUndefined();
    }),
  );
});

// ---------------------------------------------------------------------------
// The versioned protocol: metadata headers, encoding negotiation, and
// compatibility with callers and callees that predate it.
// ---------------------------------------------------------------------------

/** A loopback that records every request the stub sends. */
const withRecordedRpc = <A, E>(
  methods: Record<string, unknown>,
  use: (stub: any, sent: Request[]) => Effect.Effect<A, E, any>,
): Effect.Effect<A, E> => {
  const sent: Request[] = [];
  const webHandler = HttpEffect.toWebHandler(safeHttpEffect(Rpc.serveRpc(methods, fallback)));
  const fetchImpl = ((url: any, init?: any) => {
    const request = new Request(url, init);
    sent.push(request.clone());
    return webHandler(request);
  }) as typeof globalThis.fetch;
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const stub = Rpc.makeFetchRpcStub<any>({
      fetch: (request) => client.execute(request),
      baseUrl: "http://rpc",
    });
    return yield* use(stub, sent);
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetchImpl),
  ) as Effect.Effect<A, E>;
};

/** Call the RPC route with a raw request, as a runtime that predates the protocol would. */
const rawCall = (methods: Record<string, unknown>, init: RequestInit & { path: string }) =>
  Effect.promise(() =>
    HttpEffect.toWebHandler(safeHttpEffect(Rpc.serveRpc(methods, fallback)))(
      new Request(`http://rpc${init.path}`, { method: "POST", ...init }),
    ),
  );

describe("Rpc protocol", { tags: ["unit", "local"] }, () => {
  const methods = {
    echo: (value: unknown) => Effect.succeed(value),
    parent: () =>
      Effect.map(Effect.currentParentSpan, (span) => ({
        traceId: span.traceId,
        spanId: span.spanId,
      })),
    rows: (n: number) => Stream.range(1, n).pipe(Stream.map((i) => ({ i }))),
    blobs: () => Stream.fromIterable([new Uint8Array([1, 2]), new Uint8Array(70_000).fill(9)]),
  };

  it.effect("sends JSON first, then CBOR once the callee advertised it", () =>
    withRecordedRpc(methods, (stub, sent) =>
      Effect.gen(function* () {
        expect(yield* stub.echo("one")).toBe("one");
        expect(yield* stub.echo("two")).toBe("two");
        expect(sent.map((request) => request.headers.get("content-type"))).toEqual([
          "application/json",
          "application/cbor",
        ]);
        expect(sent.every((request) => request.headers.get("x-alchemy-rpc") === "1")).toBe(true);
      }),
    ),
  );

  it.effect("CBOR carries values JSON would change", () =>
    withRecordedRpc(methods, (stub) =>
      Effect.gen(function* () {
        yield* stub.echo(null); // learn the callee's encodings
        const value = {
          bytes: new Uint8Array([0, 255]),
          big: 2n ** 70n,
          when: new Date("2026-11-09T00:00:00.000Z"),
          map: new Map([[1, "one"]]),
          missing: undefined,
        };
        expect(yield* stub.echo(value)).toEqual(value);
      }),
    ),
  );

  it.effect("a CBOR stream carries rows and raw bytes", () =>
    withRecordedRpc(methods, (stub) =>
      Effect.gen(function* () {
        yield* stub.echo(null);
        expect(Array.from(yield* Stream.runCollect(stub.rows(3)))).toEqual([
          { i: 1 },
          { i: 2 },
          { i: 3 },
        ]);
        const blobs = Array.from(yield* Stream.runCollect(stub.blobs())) as Uint8Array[];
        expect(blobs.map((blob) => blob.length)).toEqual([2, 70_000]);
        expect(blobs[1]![69_999]).toBe(9);
      }),
    ),
  );

  it.effect("the callee runs the method as a child of the caller's span", () =>
    withRecordedRpc(methods, (stub, sent) =>
      Effect.gen(function* () {
        const caller = yield* Effect.currentSpan;
        const seen = (yield* stub.parent()) as { traceId: string; spanId: string };
        expect(seen).toEqual({ traceId: caller.traceId, spanId: caller.spanId });
        // The call's own header, which proxies leave alone.
        expect(sent[0]!.headers.get("x-alchemy-meta-traceparent")).toBe(
          `00-${caller.traceId}-${caller.spanId}-01`,
        );
      }).pipe(Effect.withSpan("caller")),
    ),
  );

  it.effect("a proxy rewriting traceparent doesn't move the parent", () =>
    Effect.gen(function* () {
      const response = yield* rawCall(methods, {
        path: "/__rpc__/parent",
        body: "[]",
        headers: {
          "content-type": "application/json",
          "x-alchemy-rpc": "1",
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
          "x-alchemy-meta-traceparent": "00-33333333333333333333333333333333-4444444444444444-01",
        },
      });
      expect(yield* Effect.promise(() => response.json())).toEqual({
        traceId: "33333333333333333333333333333333",
        spanId: "4444444444444444",
      });
    }),
  );

  it.effect("a caller that predates the protocol is parented by its bare traceparent", () =>
    Effect.gen(function* () {
      const response = yield* rawCall(methods, {
        path: "/__rpc__/parent",
        body: "[]",
        headers: {
          "content-type": "application/json",
          traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
        },
      });
      expect(yield* Effect.promise(() => response.json())).toEqual({
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
      });
    }),
  );

  it.effect("a caller that predates the protocol still gets a JSON answer", () =>
    Effect.gen(function* () {
      const response = yield* rawCall(methods, {
        path: "/__rpc__/echo",
        body: JSON.stringify([{ a: 1 }]),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("x-alchemy-rpc-accept")).toBe("cbor, json");
      expect(yield* Effect.promise(() => response.json())).toEqual({ a: 1 });
    }),
  );

  it.effect("a version the callee doesn't speak is refused, not guessed at", () =>
    Effect.gen(function* () {
      const response = yield* rawCall(methods, {
        path: "/__rpc__/echo",
        body: JSON.stringify([1]),
        headers: { "content-type": "application/json", "x-alchemy-rpc": "2" },
      });
      expect(response.status).toBe(400);
      expect(yield* Effect.promise(() => response.text())).toContain("version 2 is not supported");
    }),
  );

  it.effect("a body that isn't an argument array is a 400", () =>
    Effect.gen(function* () {
      const response = yield* rawCall(methods, {
        path: "/__rpc__/echo",
        body: JSON.stringify({ not: "an array" }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(400);
    }),
  );
});
