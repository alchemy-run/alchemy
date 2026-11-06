import * as Domain from "@alchemy.run/domain";
import * as DomainHttp from "@alchemy.run/domain/Http";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// ---------------------------------------------------------------- a wallet domain

const WalletId = Schema.String.pipe(Schema.brand("WalletId"));

/** Who is calling. The session middleware provides it from an `x-owner` header. */
class Owner extends Domain.RequestContext<Owner>()("Test/Owner", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Session extends RpcMiddleware.Service<Session, { provides: Owner }>()("Test/Session", {
  // A middleware error answers with the status it is annotated with.
  error: Unauthenticated.pipe(HttpApiSchema.status(401)),
}) {}
const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-owner"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (owner) => Effect.provideService(effect, Owner, owner),
  }),
);

class Deposited extends Domain.Event("Deposited", {
  owner: Schema.String,
  amount: Schema.Int,
  at: Schema.DateTimeUtc,
}) {}
class OverLimit extends Domain.Rejection("OverLimit", { limit: Schema.Int }) {}
/** Its status is Effect's own `httpApiStatus` annotation, which every HttpApi reads. */
class NotOwner extends Domain.Rejection("NotOwner", {}, { httpApiStatus: 403 }) {}

class Deposit extends Domain.Command("Deposit", {
  target: WalletId,
  middleware: [Session],
  // `at` is a transform (an ISO string on the wire, a DateTime in `decide`).
  input: { amount: Schema.Int, at: Schema.DateTimeUtc },
  events: [Deposited],
  rejects: [OverLimit],
  reply: { balance: Schema.Int, at: Schema.NullOr(Schema.DateTimeUtc) },
}) {}

const WalletState = Schema.Struct({
  owner: Schema.NullOr(Schema.String),
  balance: Schema.Int,
  at: Schema.NullOr(Schema.DateTimeUtc),
});

class Wallet extends Domain.Aggregate("Wallet", {
  id: WalletId,
  state: WalletState,
  initial: { owner: null, balance: 0, at: null },
  commands: [Deposit],
  decide: {
    Deposit: Effect.fn(function* (_, cmd) {
      if (cmd.amount > 100) return yield* new OverLimit({ limit: 100 });
      return [new Deposited({ owner: yield* Owner, amount: cmd.amount, at: cmd.at })];
    }),
  },
  evolve: {
    Deposited: (s, e) => ({ owner: e.owner, balance: s.balance + e.amount, at: e.at }),
  },
  reply: { Deposit: (s) => ({ balance: s.balance, at: s.at }) },
}) {}

/** Only the wallet's owner reads its balance. */
class Balance extends Domain.View(
  "Balance",
  {
    from: [Wallet],
    key: Wallet,
    middleware: [Session],
    rejects: [NotOwner],
    state: Schema.Struct({ owner: Schema.String, balance: Schema.Int }),
    initial: { owner: "", balance: 0 },
    evolve: { Deposited: (s, e) => ({ owner: e.owner, balance: s.balance + e.amount }) },
  },
  { httpApiCacheControl: "private, max-age=5" },
) {}

/** Who may read each key of Balance. */
const BalanceLive = Balance.toLayer(
  Effect.succeed(
    Effect.fn(function* (_request, s) {
      if (s !== null && s.owner !== (yield* Owner)) return yield* new NotOwner();
    }),
  ),
);

// ---------------------------------------------------------------- the HTTP surface

/**
 * A session with a client half: a typed client attaches the caller as
 * `x-owner`. The server holds one for its own calls, as "server".
 */
class SignedSession extends RpcMiddleware.Service<SignedSession, { provides: Owner }>()(
  "Test/SignedSession",
  { error: Unauthenticated.pipe(HttpApiSchema.status(401)), requiredForClient: true },
) {}
const SignedSessionLive = Layer.succeed(SignedSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-owner"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (owner) => Effect.provideService(effect, Owner, owner),
  }),
);
const ServerCredential = RpcMiddleware.layerClient(SignedSession, ({ request, next }) =>
  next({ ...request, headers: Headers.set(request.headers, "x-owner", "server") }),
);

class Signed extends Domain.Event("Signed", { owner: Schema.String }) {}
class Sign extends Domain.Command("Sign", {
  target: Schema.String,
  middleware: [SignedSession],
  events: [Signed],
  reply: { owner: Schema.NullOr(Schema.String) },
}) {}
class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({ owner: Schema.NullOr(Schema.String) }),
  initial: { owner: null },
  commands: [Sign],
  decide: {
    Sign: Effect.fn(function* () {
      return [new Signed({ owner: yield* Owner })];
    }),
  },
  evolve: { Signed: (_, e) => ({ owner: e.owner }) },
  reply: { Sign: (s) => ({ owner: s.owner }) },
}) {}
class UnknownBase extends Domain.Rejection("UnknownBase", { base: Schema.String }) {}

/** Exchange rates: a paged query over rows outside the model. */
class Rates extends Domain.Query(
  "Rates",
  {
    input: { base: Schema.String },
    success: Schema.Struct({ currency: Schema.String, rate: Schema.Number }),
    paged: true,
    middleware: [Session],
    rejects: [UnknownBase],
  },
  { httpApiCacheControl: "public, max-age=60" },
) {}
const rates = [
  { currency: "EUR", rate: 0.9 },
  { currency: "GBP", rate: 0.8 },
  { currency: "JPY", rate: 150 },
];
const RatesLive = Rates.toLayer(
  Effect.succeed(({ base }, { after, take }) => {
    if (base !== "USD") return Effect.fail(new UnknownBase({ base }));
    const rest = rates.filter((row) => after === undefined || row.currency > after);
    const entries = rest.slice(0, take);
    return Effect.succeed({
      entries,
      cursor: rest.length > take ? entries.at(-1)!.currency : null,
    });
  }),
);

class Wallets extends Domain.Model("HttpWallets", {
  aggregates: [Wallet, Ledger],
  views: [Balance],
  queries: [Rates],
}) {}
class WalletApi extends Domain.Api("WalletApi", {
  model: Wallets,
  commands: ["Deposit"],
}) {}
class LedgerApi extends Domain.Api("LedgerApi", {
  model: Wallets,
  commands: ["Sign"],
  views: [],
}) {}

/** Every call the Api serves, listed in a different order than the Api serves them. */
const WalletHttp = DomainHttp.toHttpApi(WalletApi, {
  expose: [
    "Balance.snapshot",
    "Balance.list",
    "Balance.events",
    "Balance.watch",
    "Balance.get",
    "Rates",
    "Deposit",
  ],
});

/** The hosted model, its middleware, and an in-process Bun server with a client for it. */
const Hosted = Layer.mergeAll(
  SessionLive,
  SignedSessionLive,
  ServerCredential,
  Wallets.layer(Layer.merge(RatesLive, BalanceLive)),
).pipe(Layer.provide(InMemory), Layer.provideMerge(BunHttpServer.layerTest));

const serve = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  handlers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, never, Layer.Success<typeof Hosted>>,
) =>
  HttpRouter.serve(HttpApiBuilder.layer(api), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(handlers),
    Layer.provideMerge(Hosted),
  );

/** The surface's own HttpApi, served. */
const Served = serve(WalletHttp.api, WalletHttp.layer);

/** An app's own HttpApi that serves the group under `/v1`. */
const AppApi = HttpApi.make("App").add(WalletHttp.group.prefix("/v1"));

interface SendOptions {
  readonly owner?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

const execute = (method: "GET" | "POST" | "QUERY", path: string, options: SendOptions) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(method)(path).pipe(
      HttpClientRequest.setHeaders(options.headers ?? {}),
    );
    if (options.owner) request = HttpClientRequest.setHeader(request, "x-owner", options.owner);
    if (options.body !== undefined)
      request = HttpClientRequest.bodyJsonUnsafe(request, options.body);
    return yield* client.execute(request);
  });

const send = (method: "GET" | "POST" | "QUERY", path: string, options: SendOptions = {}) =>
  Effect.gen(function* () {
    const response = yield* execute(method, path, options);
    const text = yield* response.text;
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  });

/**
 * Open a live read. The status arrives once the read has its first value, so
 * the read is subscribed when this returns; `take(n)` collects the next `n`
 * SSE events, each with its parsed `data`.
 */
const listen = (path: string, options: SendOptions = {}) =>
  Effect.gen(function* () {
    const response = yield* execute("GET", path, options);
    const contentType = response.headers["content-type"];
    const take = (n: number) =>
      response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.take(n),
        Stream.map((event) => ({ event: event.event, data: JSON.parse(event.data) })),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      );
    return { status: response.status, contentType, take };
  });

const at = "2026-10-25T12:00:00.000Z";

// ---------------------------------------------------------------- tests

describe("Domain toHttpApi", { tags: ["unit", "local"] }, () => {
  it.live("a command endpoint runs the command and answers with its receipt", () =>
    Effect.gen(function* () {
      const { status, body } = yield* send("POST", "/Deposit", {
        owner: "sam",
        body: { target: "w-1", input: { amount: 40, at } },
      });
      expect(status).toBe(200);
      // The transform is decoded once on the way in and encoded once on the way out.
      expect(body).toEqual({ reply: { balance: 40, at }, stream: expect.any(String), version: 1 });
    }).pipe(Effect.provide(Served)),
  );

  it.live("a rejection answers with its status and its typed body", () =>
    Effect.gen(function* () {
      const over = yield* send("POST", "/Deposit", {
        owner: "sam",
        body: { target: "w-1", input: { amount: 500, at } },
      });
      // A declared rejection with no status of its own is a 422.
      expect(over).toEqual({ status: 422, body: { _tag: "OverLimit", limit: 100 } });

      // The middleware runs as for any client, and its error keeps its annotated status.
      const anonymous = yield* send("POST", "/Deposit", {
        body: { target: "w-1", input: { amount: 1, at } },
      });
      expect(anonymous).toEqual({ status: 401, body: { _tag: "Unauthenticated" } });

      // Input the command's schema refuses never reaches the model.
      const malformed = yield* send("POST", "/Deposit", {
        owner: "sam",
        body: { target: "w-1", input: { amount: "lots", at } },
      });
      expect(malformed.status).toBe(400);
    }).pipe(Effect.provide(Served)),
  );

  it.live("a query endpoint takes its input and page in the body, and answers with a page", () =>
    Effect.gen(function* () {
      const first = yield* send("QUERY", "/Rates", {
        owner: "sam",
        body: { input: { base: "USD" }, take: 2 },
      });
      expect(first).toEqual({
        status: 200,
        body: {
          entries: [
            { currency: "EUR", rate: 0.9 },
            { currency: "GBP", rate: 0.8 },
          ],
          cursor: "GBP",
        },
      });
      const next = yield* send("QUERY", "/Rates", {
        owner: "sam",
        body: { input: { base: "USD" }, after: "GBP" },
      });
      expect(next.body).toEqual({ entries: [{ currency: "JPY", rate: 150 }], cursor: null });
      // Its rejection and its middleware's error answer with their statuses.
      const unknown = yield* send("QUERY", "/Rates", {
        owner: "sam",
        body: { input: { base: "XYZ" } },
      });
      expect(unknown).toEqual({ status: 422, body: { _tag: "UnknownBase", base: "XYZ" } });
      const anonymous = yield* send("QUERY", "/Rates", { body: { input: { base: "USD" } } });
      expect(anonymous.status).toBe(401);
    }).pipe(Effect.provide(Served)),
  );

  it.live(
    "a successful answer carries its declaration's httpApiCacheControl; everything else is private, no-store",
    () =>
      Effect.gen(function* () {
        const responses = [
          yield* execute("POST", "/Deposit", {
            owner: "sam",
            body: { target: "w-cache", input: { amount: 1, at } },
          }),
          yield* execute("QUERY", "/Rates", { owner: "sam", body: { input: { base: "USD" } } }),
          yield* execute("QUERY", "/Rates", { owner: "sam", body: { input: { base: "XYZ" } } }),
          yield* execute("QUERY", "/Rates", { body: { input: { base: "USD" } } }),
          yield* execute("GET", "/Balance/w-cache", { owner: "sam" }),
          yield* execute("GET", "/Balance/w-cache/watch", { owner: "sam" }),
          yield* execute("GET", "/Balance/w-cache", { owner: "kim" }),
        ];
        // Read the watch's first event, so its stream closes before the server stops.
        yield* responses[5]!.stream.pipe(Stream.take(1), Stream.runDrain);
        expect(responses.map((response) => response.status)).toEqual([
          200, 200, 422, 401, 200, 200, 403,
        ]);
        expect(responses.map((response) => response.headers["cache-control"])).toEqual([
          // A command's receipt.
          "private, no-store",
          // The query's answer, then its rejection and its middleware's error.
          "public, max-age=60",
          "private, no-store",
          "private, no-store",
          // The view's read, its live read, and its rejection.
          "private, max-age=5",
          "private, no-store",
          "private, no-store",
        ]);
      }).pipe(Effect.provide(Served)),
  );

  it.live("a read endpoint answers with the key's state, read after a write", () =>
    Effect.gen(function* () {
      const { body: receipt } = yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-2", input: { amount: 25, at } },
      });
      const read = yield* send(
        "GET",
        `/Balance/w-2?stream=${encodeURIComponent(receipt.stream)}&version=${receipt.version}`,
        { owner: "kim" },
      );
      expect(read).toEqual({ status: 200, body: { owner: "kim", balance: 25 } });

      // The view's `validate` runs, and its rejection takes the status `toHttpApi` gave it.
      const someoneElse = yield* send("GET", "/Balance/w-2", { owner: "sam" });
      expect(someoneElse).toEqual({ status: 403, body: { _tag: "NotOwner" } });

      // A key with nothing in it reads as `null`, like the Api's own `get`.
      const empty = yield* send("GET", "/Balance/w-9", { owner: "kim" });
      expect(empty).toEqual({ status: 200, body: null });

      // `stream` without `version` is not a position to wait for.
      const half = yield* send("GET", "/Balance/w-2?stream=x", { owner: "kim" });
      expect(half.status).toBe(400);
    }).pipe(Effect.provide(Served)),
  );

  it.live("a snapshot endpoint answers with the state and its cursor", () =>
    Effect.gen(function* () {
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-4", input: { amount: 7, at } },
      });
      const snapshot = yield* send("GET", "/Balance/w-4/snapshot", { owner: "kim" });
      expect(snapshot).toEqual({
        status: 200,
        body: { state: { owner: "kim", balance: 7 }, cursor: expect.any(Number) },
      });
      // Its own path: `get` still answers with the bare state.
      expect((yield* send("GET", "/Balance/w-4", { owner: "kim" })).body).toEqual({
        owner: "kim",
        balance: 7,
      });
    }).pipe(Effect.provide(Served)),
  );

  it.live("a watch endpoint streams the state, then every change, as Server-Sent Events", () =>
    Effect.gen(function* () {
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-5", input: { amount: 10, at } },
      });
      const watch = yield* listen("/Balance/w-5/watch", { owner: "kim" });
      expect(watch.status).toBe(200);
      expect(watch.contentType).toContain("text/event-stream");
      const events = yield* Effect.forkChild(watch.take(2));
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-5", input: { amount: 5, at } },
      });
      expect(yield* Fiber.join(events)).toEqual([
        {
          event: "message",
          data: { state: { owner: "kim", balance: 10 }, cursor: expect.any(Number) },
        },
        {
          event: "message",
          data: { state: { owner: "kim", balance: 15 }, cursor: expect.any(Number) },
        },
      ]);
    }).pipe(Effect.provide(Served)),
  );

  it.live("a live read's middleware and validate answer with their status before it streams", () =>
    Effect.gen(function* () {
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-6", input: { amount: 1, at } },
      });
      // The session middleware refuses a caller with no owner.
      expect(yield* send("GET", "/Balance/w-6/watch")).toEqual({
        status: 401,
        body: { _tag: "Unauthenticated" },
      });
      // The view's `validate` refuses someone else's wallet.
      expect(yield* send("GET", "/Balance/w-6/watch", { owner: "sam" })).toEqual({
        status: 403,
        body: { _tag: "NotOwner" },
      });
      // The view's middleware guards its events too.
      expect((yield* send("GET", "/Balance/w-6/events")).status).toBe(401);
    }).pipe(Effect.provide(Served)),
  );

  it.live("a change validate refuses ends the stream with a typed failure event", () =>
    Effect.gen(function* () {
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-7", input: { amount: 1, at } },
      });
      const watch = yield* listen("/Balance/w-7/watch", { owner: "kim" });
      const events = yield* Effect.forkChild(watch.take(3));
      // Sam's deposit makes Sam the owner, so Kim may no longer read the wallet.
      yield* send("POST", "/Deposit", {
        owner: "sam",
        body: { target: "w-7", input: { amount: 1, at } },
      });
      const [first, failure, ...rest] = yield* Fiber.join(events);
      expect(first!.data.state).toEqual({ owner: "kim", balance: 1 });
      expect(failure!.event).toBe("effect/http-api/stream/failure");
      // A typed failure, not a defect: the Cause of the rejection `validate` returned.
      expect(failure!.data).toEqual([{ _tag: "Fail", error: { _tag: "NotOwner" } }]);
      // The failure ends the stream.
      expect(rest).toEqual([]);
    }).pipe(Effect.provide(Served)),
  );

  it.live("an events endpoint streams history, a CaughtUp frame, then live events", () =>
    Effect.gen(function* () {
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-8", input: { amount: 2, at } },
      });
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-8", input: { amount: 3, at } },
      });
      const all = yield* listen("/Balance/w-8/events", { owner: "kim" });
      const history = yield* Effect.forkChild(all.take(4));
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-8", input: { amount: 4, at } },
      });
      const frames = (yield* Fiber.join(history)).map(({ data }) =>
        data._tag === "CaughtUp" ? "caught up" : data.event.amount,
      );
      expect(frames).toEqual([2, 3, "caught up", 4]);

      // `after` resumes from a cursor: only what came after it, then the frame.
      const [, second] = (yield* Fiber.join(history)).map(({ data }) => data);
      const resumed = yield* listen(`/Balance/w-8/events?after=${second.envelope.seq}`, {
        owner: "kim",
      });
      const tail = (yield* resumed.take(2)).map(({ data }) =>
        data._tag === "CaughtUp" ? "caught up" : data.event.amount,
      );
      expect(tail).toEqual([4, "caught up"]);
    }).pipe(Effect.provide(Served)),
  );

  it.live("a middleware's client half never replaces the HTTP caller's headers", () =>
    Effect.gen(function* () {
      // The server holds a credential for its own calls; an HTTP caller signs as itself.
      expect(
        yield* send("POST", "/Sign", { owner: "alice", body: { target: "l-1", input: {} } }),
      ).toEqual({
        status: 200,
        body: { reply: { owner: "alice" }, stream: "Ledger/l-1", version: 1 },
      });
      // A caller without one is refused, not signed in as the server.
      expect(yield* send("POST", "/Sign", { body: { target: "l-2", input: {} } })).toEqual({
        status: 401,
        body: { _tag: "Unauthenticated" },
      });
    }).pipe(
      Effect.provide(
        (() => {
          const LedgerHttp = DomainHttp.toHttpApi(LedgerApi, { expose: ["Sign"] });
          return serve(LedgerHttp.api, LedgerHttp.layer);
        })(),
      ),
    ),
  );

  it.live("serves the group inside your own HttpApi, under its prefix", () =>
    Effect.gen(function* () {
      const deposit = yield* send("POST", "/v1/Deposit", {
        owner: "sam",
        body: { target: "w-3", input: { amount: 5, at } },
      });
      expect(deposit.status).toBe(200);
      expect((yield* send("POST", "/Deposit", { owner: "sam", body: {} })).status).toBe(404);
    }).pipe(Effect.provide(serve(AppApi, WalletHttp.layerFor(AppApi)))),
  );

  it.live("publishes only the calls it exposes", () =>
    Effect.gen(function* () {
      const deposit = yield* send("POST", "/Deposit", {
        owner: "sam",
        body: { target: "w-10", input: { amount: 2, at } },
      });
      expect(deposit.status).toBe(200);
      expect((yield* send("GET", "/Balance/w-10", { owner: "sam" })).status).toBe(404);
      expect((yield* send("GET", "/Balance/w-10/watch", { owner: "sam" })).status).toBe(404);
    }).pipe(
      Effect.provide(
        (() => {
          const DepositOnlyHttp = DomainHttp.toHttpApi(WalletApi, { expose: ["Deposit"] });
          return serve(DepositOnlyHttp.api, DepositOnlyHttp.layer);
        })(),
      ),
    ),
  );

  it("the OpenAPI document carries each entry's description annotation", () => {
    class Credited extends Domain.Event("Credited", { balance: Schema.Int }) {}
    class Credit extends Domain.Command(
      "Credit",
      {
        target: Schema.String,
        events: [Credited],
      },
      { description: "Add a cent to a purse." },
    ) {}
    class Purse extends Domain.Aggregate("Purse", {
      id: Schema.String,
      state: Schema.Struct({ balance: Schema.Int }),
      initial: { balance: 0 },
      commands: [Credit],
      decide: { Credit: () => [] },
      evolve: { Credited: (_, e) => ({ balance: e.balance }) },
    }) {}
    class PurseBalance extends Domain.View(
      "PurseBalance",
      {
        from: [Purse],
        key: Purse,
        state: Schema.Struct({ balance: Schema.Int }),
        initial: { balance: 0 },
        evolve: { Credited: (_, e) => ({ balance: e.balance }) },
      },
      { description: "A purse's balance." },
    ) {}
    class Purses extends Domain.Model("Purses", { aggregates: [Purse], views: [PurseBalance] }) {}
    class PurseApi extends Domain.Api(
      "PurseApi",
      {
        model: Purses,
      },
      { description: "What a purse app reaches." },
    ) {}
    const spec = OpenApi.fromApi(
      DomainHttp.toHttpApi(PurseApi, { expose: ["Credit", "PurseBalance.get"] }).api,
    );
    expect(spec.info.description).toBe("What a purse app reaches.");
    expect(spec.paths["/Credit"]!.post!.description).toBe("Add a cent to a purse.");
    expect(spec.paths["/PurseBalance/{key}"]!.get!.description).toBe("A purse's balance.");
  });

  it("the OpenAPI document lists each endpoint with its schemas", () => {
    const spec = OpenApi.fromApi(WalletHttp.api);
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/Balance/{key}",
      "/Balance/{key}/events",
      "/Balance/{key}/list",
      "/Balance/{key}/snapshot",
      "/Balance/{key}/watch",
      "/Deposit",
      "/Rates",
    ]);

    const deposit = spec.paths["/Deposit"]!.post!;
    expect(deposit.operationId).toBe("WalletApi.Deposit");
    const body = JSON.stringify(deposit.requestBody);
    for (const field of ["target", "amount", "at", "commandId"]) expect(body).toContain(field);
    expect(Object.keys(deposit.responses).sort()).toEqual(["200", "401", "422"]);
    expect(JSON.stringify(deposit.responses["422"])).toContain("OverLimit");

    // OpenAPI 3.1 has no `query` slot, so the QUERY operation sits under the 3.2 extension.
    const ratesOp = spec.paths["/Rates"]!["x-oai-additionalOperations"]!.QUERY!;
    expect(ratesOp.operationId).toBe("WalletApi.Rates");
    for (const field of ["input", "base", "after", "take", "atLeast"]) {
      expect(JSON.stringify(ratesOp.requestBody)).toContain(field);
    }
    expect(Object.keys(ratesOp.responses).sort()).toEqual(["200", "401", "422"]);
    expect(JSON.stringify(ratesOp.responses["422"])).toContain("UnknownBase");

    const balance = spec.paths["/Balance/{key}"]!.get!;
    expect(balance.parameters.map((p) => [p.name, p.in]).sort()).toEqual([
      ["key", "path"],
      ["stream", "query"],
      ["version", "query"],
    ]);
    // Waiting for a write can time out: `ConsistencyTimeout` is a 422.
    expect(Object.keys(balance.responses).sort()).toEqual(["200", "401", "403", "422"]);
    expect(JSON.stringify(balance.responses["422"])).toContain("ConsistencyTimeout");
    // A live read is an event stream, with its failures before it starts.
    const watch = spec.paths["/Balance/{key}/watch"]!.get!;
    expect(Object.keys(watch.responses["200"]!.content ?? {})).toEqual(["text/event-stream"]);
    expect(Object.keys(watch.responses).sort()).toEqual(["200", "401", "403"]);
    const events = spec.paths["/Balance/{key}/events"]!.get!;
    expect(events.parameters.map((p) => [p.name, p.in]).sort()).toEqual([
      ["after", "query"],
      ["key", "path"],
    ]);

    // The schemas the document refers to, as components.
    const components = JSON.stringify(spec.components.schemas);
    for (const tag of ["OverLimit", "Unauthenticated", "NotOwner"]) {
      expect(components).toContain(tag);
    }
  });

  it("publishes nothing it is not told to expose", () => {
    // @ts-expect-error a call the Api does not serve
    DomainHttp.toHttpApi(WalletApi, { expose: ["Withdraw"] });
    // @ts-expect-error an operation the view does not have
    DomainHttp.toHttpApi(WalletApi, { expose: ["Balance.nope"] });
    // @ts-expect-error an aggregate's state is not served
    DomainHttp.toHttpApi(WalletApi, { expose: ["Wallet.get"] });
    // every read of a view, live ones included
    DomainHttp.toHttpApi(WalletApi, {
      expose: ["Balance.get", "Balance.watch", "Balance.events"],
    });
    expect(Object.keys(DomainHttp.toHttpApi(WalletApi).group.endpoints)).toEqual([]);
    expect(Object.keys(DomainHttp.toHttpApi(WalletApi, { expose: [] }).group.endpoints)).toEqual(
      [],
    );
  });

  it("publishes exposed calls in the order the Api serves them: commands, views, streams, then queries", () => {
    expect(
      Object.values(WalletHttp.group.endpoints).map((e) => [e.identifier, e.method, e.path]),
    ).toEqual([
      ["Deposit", "POST", "/Deposit"],
      ["Balance.get", "GET", "/Balance/:key"],
      ["Balance.watch", "GET", "/Balance/:key/watch"],
      ["Balance.events", "GET", "/Balance/:key/events"],
      ["Balance.list", "GET", "/Balance/:key/list"],
      ["Balance.snapshot", "GET", "/Balance/:key/snapshot"],
      ["Rates", "QUERY", "/Rates"],
    ]);
  });

  it.live("layerFor an HttpApi without the group fails the Layer with a DefinitionError", () =>
    Effect.gen(function* () {
      /** The defect building the surface's Layer dies with. */
      const defectOf = (surface: { readonly layer: Layer.Layer<any, never, any> }) =>
        Layer.build(surface.layer).pipe(
          Effect.provide(Hosted),
          Effect.scoped,
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
        );

      // `layerFor` an HttpApi that does not hold the group.
      const elsewhere = yield* defectOf({ layer: WalletHttp.layerFor(HttpApi.make("Elsewhere")) });
      expect(elsewhere).toMatchObject({
        _tag: "DefinitionError",
        message: "Elsewhere does not hold the WalletApi group: add it first",
      });
    }),
  );
});
