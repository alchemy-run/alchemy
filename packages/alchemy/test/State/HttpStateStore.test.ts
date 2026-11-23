import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import {
  checkHttpStateStoreAuth,
  describeStateStoreFailure,
  makeHttpStateStore,
} from "@/State/HttpStateStore.ts";
import { passphraseEncryption } from "@/State/PassphraseEncryption.ts";
import { stateCodec } from "@/State/StateEncryption.ts";

/**
 * Hermetic tests driven by the production failure modes observed in
 * Axiom (`prod-traces`, spans `state_store.*`):
 *
 * - `StateStoreError` with an EMPTY message (31 hits / 14 users on
 *   beta.57–59) — thrown from `mapStateStoreError` when the client
 *   error carried no message (e.g. the no-content 401).
 * - opaque `Decode error (500 PUT <url>)` — worker 5xx bodies that
 *   fail response decoding.
 * - `Transport error (GET .../state/stacks)` / `fetch failed` — not
 *   retried by `checkHttpStateStoreAuth`.
 *
 * All HTTP traffic is stubbed through the `FetchHttpClient.Fetch`
 * reference — no sockets, no cloud.
 */

/** Minimal fetch signature — Bun's `typeof fetch` also demands `preconnect`. */
type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Build an HttpClient layer whose transport is the given fetch stub. */
const stubHttpClient = (stub: FetchStub) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub as typeof globalThis.fetch)),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sampleValue = { fqn: "stack/scope/a", props: { hello: "world" } };

const makeStore = makeHttpStateStore({
  url: "https://state-store.test",
  authToken: "token",
  id: "test-http",
});

describe("describeStateStoreFailure", { tags: ["unit", "local"] }, () => {
  it("never returns an empty message", () => {
    class Empty extends Error {
      readonly _tag = "SomeTaggedError";
      constructor() {
        super("");
      }
    }
    const message = describeStateStoreFailure(new Empty());
    expect(message.length).toBeGreaterThan(0);
  });

  it("maps Unauthorized errors to an actionable message", () => {
    const message = describeStateStoreFailure(new HttpApiError.Unauthorized());
    expect(message).toContain("unauthorized");
    expect(message).toContain("alchemy profile edit");
  });

  it("appends the HTTP status when the error carries a response", () => {
    const request = HttpClientRequest.put("https://state-store.test");
    const response = HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }));
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({ request, response }),
    });
    expect(describeStateStoreFailure(error)).toContain("500");
  });

  it("omits arbitrary error and cause messages", () => {
    const cause = new Error("secret cause");
    const outer = new Error("secret message");
    outer.cause = cause;
    const message = describeStateStoreFailure(outer);
    expect(message).not.toContain("secret");
    expect(message.length).toBeGreaterThan(0);
  });

  it("omits non-Error failures that may contain state", () => {
    expect(describeStateStoreFailure("secret state")).not.toContain("secret");
  });
});

describe("makeHttpStateStore", { tags: ["unit", "local"] }, () => {
  // Regression: https://github.com/reve-ai/kommunikasie/commit/f2e7320ff261833092b84d8aa25e3563710661e8
  // State encoding unwraps Redacted values before HTTP. Neither the request
  // object nor transport/decoder messages may escape through diagnostics.
  for (const failure of ["status", "decode", "transport"] as const) {
    it.effect(`does not expose serialized state after a ${failure} failure`, () => {
      const secret = "STATE_PAYLOAD_SENTINEL_91f4";
      const logs: string[] = [];
      let requestBody = "";
      const logger = Logger.make(({ cause, message }) => {
        logs.push(JSON.stringify({ cause, message }));
      });
      const stub: FetchStub = async (_input, init) => {
        requestBody = await new Response(init?.body).text();
        if (failure === "transport") throw new Error(secret);
        return new Response(secret, {
          status: failure === "status" ? 400 : 200,
          headers: { "content-type": "application/json" },
        });
      };
      return Effect.gen(function* () {
        const store = yield* makeStore;
        const fiber = yield* store
          .set({
            stack: "s",
            stage: "dev",
            fqn: "secret",
            value: {
              kind: "action",
              actionType: "SecretState",
              namespace: undefined,
              fqn: "secret",
              logicalId: "secret",
              status: "ran",
              downstream: [],
              inputHash: "input-hash",
              input: { token: Redacted.make(secret) },
              output: null,
            },
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const error = yield* Fiber.join(fiber);
        expect(requestBody).toContain(secret);
        expect(JSON.stringify({ error, logs })).not.toContain(secret);
        expect(error.cause).toBeUndefined();
        expect(error.message).not.toContain(secret);
        expect(error.message.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(stubHttpClient(stub)), Effect.provide(Logger.layer([logger])));
    });
  }

  it.live("retries transient 5xx and then succeeds", () => {
    let calls = 0;
    const stub: FetchStub = async () => {
      calls++;
      return calls < 3 ? new Response("internal error", { status: 500 }) : json(sampleValue);
    };
    return Effect.gen(function* () {
      const store = yield* makeStore;
      const result = yield* store.set({
        stack: "s",
        stage: "dev",
        fqn: "stack/scope/a",
        value: sampleValue as never,
      });
      expect(result).toEqual(sampleValue);
      expect(calls).toBe(3);
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });

  it.live(
    "surfaces a persistent 5xx as a StateStoreError with status context",
    () => {
      let calls = 0;
      const stub: FetchStub = async () => {
        calls++;
        return new Response("secrets store binding unavailable", { status: 500 });
      };
      return Effect.gen(function* () {
        const store = yield* makeStore;
        const error = yield* store
          .set({ stack: "s", stage: "dev", fqn: "stack/scope/a", value: sampleValue as never })
          .pipe(Effect.flip);
        expect(error._tag).toBe("StateStoreError");
        expect(error.message.trim().length).toBeGreaterThan(0);
        expect(error.message).toContain("500");
        // initial attempt + 5 bounded retries
        expect(calls).toBe(6);
      }).pipe(Effect.provide(stubHttpClient(stub)));
    },
    30_000,
  );

  // #1833: a failure behind the auth middleware (a Durable Object call, a
  // Secrets Store read) used to encode as its `Unauthorized` and surface as an
  // empty 500. The store now answers a typed StateStoreFailure.
  it.live(
    "retries a StateStoreFailure, then names the failed operation",
    () => {
      let calls = 0;
      const stub: FetchStub = async () => {
        calls++;
        return json(
          { _tag: "StateStoreFailure", operation: "getState", reason: "RpcCallError" },
          500,
        );
      };
      return Effect.gen(function* () {
        const store = yield* makeStore;
        const error = yield* store
          .get({ stack: "s", stage: "dev", fqn: "stack/scope/a" })
          .pipe(Effect.flip);
        expect(error.message).toBe(
          "State store failed to getState (RpcCallError); its logs have the cause.",
        );
        expect(error.http).toEqual({ status: 500 });
        // initial attempt + 5 bounded retries
        expect(calls).toBe(6);
      }).pipe(Effect.provide(stubHttpClient(stub)));
    },
    30_000,
  );

  it.live("the credential check retries a StateStoreFailure", () => {
    let calls = 0;
    const stub: FetchStub = async () => {
      calls++;
      return calls < 3
        ? json({ _tag: "StateStoreFailure", operation: "listStacks", reason: "RpcCallError" }, 500)
        : json([]);
    };
    return checkHttpStateStoreAuth({ url: "https://state-store.test", authToken: "token" }).pipe(
      Effect.map((authorized) => {
        expect(authorized).toBe(true);
        expect(calls).toBe(3);
      }),
      Effect.provide(stubHttpClient(stub)),
    );
  });

  it.live("maps a no-content 401 to a non-empty, actionable error", () => {
    const stub: FetchStub = async () => new Response(null, { status: 401 });
    return Effect.gen(function* () {
      const store = yield* makeStore;
      const error = yield* store.listStacks().pipe(Effect.flip);
      expect(error._tag).toBe("StateStoreError");
      expect(error.message.trim().length).toBeGreaterThan(0);
      expect(error.message).toContain("unauthorized");
      expect(error.message).toContain("alchemy profile edit");
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });

  it.live(
    "maps a non-JSON 200 body to a non-empty StateStoreError instead of a bare SyntaxError",
    () => {
      const stub: FetchStub = async () =>
        new Response("Alchemy State Store", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return Effect.gen(function* () {
        const store = yield* makeStore;
        const error = yield* store.listStacks().pipe(Effect.flip);
        expect(error._tag).toBe("StateStoreError");
        expect(error.message.trim().length).toBeGreaterThan(0);
      }).pipe(Effect.provide(stubHttpClient(stub)));
    },
  );
});

/**
 * The state API in memory, keyed by request path. A function in `between`
 * runs once, right after the API answers a read of its path and before the
 * client sees the answer: another writer's turn.
 */
const memoryStateApi = () => {
  const records = new Map<string, unknown>();
  const between = new Map<string, () => void>();
  const stub: FetchStub = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "PUT") {
      const value: unknown = await request.json();
      records.set(path, value);
      return json(value);
    }
    const value = records.get(path) ?? null;
    const write = between.get(path);
    between.delete(path);
    write?.();
    return json(value);
  };
  return { records, between, stub };
};

describe("makeHttpStateStore with StateEncryption", { tags: ["unit", "local"] }, () => {
  const scope = { stack: "app", stage: "prod" };
  const path = "/state/stacks/app/stages/prod/resources/Database";
  const passphrase = Redacted.make("correct horse battery staple");
  const atVersion = (version: number) => ({
    status: "created",
    attr: { version, password: Redacted.make("hunter2") },
  });
  /** The stored JSON of a record, as a store with `options` writes it. */
  const storedWith = (options: Parameters<typeof passphraseEncryption>[0]) => (value: unknown) =>
    stateCodec.pipe(
      Effect.flatMap((codec) => codec.encodeJson(scope, value)),
      Effect.provide(passphraseEncryption(options)),
    );
  const versionOf = (json: unknown) =>
    stateCodec.pipe(
      Effect.flatMap((codec) =>
        codec.decodeJson<ReturnType<typeof atVersion>>(scope, json, "record"),
      ),
      Effect.map((value) => value.attr.version),
      Effect.provide(passphraseEncryption({ passphrase })),
    );

  for (const { converting, stored, reader } of [
    {
      converting: "seals a plaintext secret",
      stored: storedWith({ passphrase, disable: true }),
      reader: { passphrase },
    },
    {
      converting: "opens a sealed secret with disable",
      stored: storedWith({ passphrase }),
      reader: { passphrase, disable: true },
    },
  ]) {
    // HttpStateStore.ts get: a stale record is written back with an
    // unconditional set, after the read it decoded.
    it.effect(`a converting read does not overwrite a newer write (it ${converting})`, () => {
      const api = memoryStateApi();
      return Effect.gen(function* () {
        api.records.set(path, yield* stored(atVersion(1)));
        const v2 = yield* stored(atVersion(2));
        // A deploy of the stage writes v2 just after the API answers the
        // reader with v1.
        api.between.set(path, () => api.records.set(path, v2));

        const store = yield* makeStore.pipe(Effect.provide(passphraseEncryption(reader)));
        yield* store.get({ ...scope, fqn: "Database" });

        expect(yield* versionOf(api.records.get(path))).toBe(2);
      }).pipe(Effect.provide(stubHttpClient(api.stub)));
    });
  }
});

describe("checkHttpStateStoreAuth", { tags: ["unit", "local"] }, () => {
  const check = checkHttpStateStoreAuth({ url: "https://state-store.test", authToken: "token" });

  it.live("retries transport-level failures before succeeding", () => {
    let calls = 0;
    const stub: FetchStub = async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return json([]);
    };
    return Effect.gen(function* () {
      const isAuthed = yield* check;
      expect(isAuthed).toBe(true);
      expect(calls).toBe(3);
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });

  it.live("returns false on 401 without retrying", () => {
    let calls = 0;
    const stub: FetchStub = async () => {
      calls++;
      return new Response(null, { status: 401 });
    };
    return Effect.gen(function* () {
      const isAuthed = yield* check;
      expect(isAuthed).toBe(false);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });
});
