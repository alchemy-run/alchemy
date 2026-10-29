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
class NotOwner extends Domain.Rejection("NotOwner") {}

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
  read: { middleware: [Session] },
}) {}

/** Only the wallet's owner reads its balance. */
class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  middleware: [Session],
  rejects: [NotOwner],
  state: Schema.Struct({ owner: Schema.String, balance: Schema.Int }),
  initial: { owner: "", balance: 0 },
  evolve: { Deposited: (s, e) => ({ owner: e.owner, balance: s.balance + e.amount }) },
  validate: Effect.fn(function* (_request, s) {
    if (s !== null && s.owner !== (yield* Owner)) return yield* new NotOwner();
  }),
}) {}

class Wallets extends Domain.Model("HttpWallets", {
  aggregates: [Wallet],
  views: [Balance],
}) {}
class WalletApi extends Domain.Api("WalletApi", Deposit, Wallet, Balance) {}

// ---------------------------------------------------------------- the HTTP surface

/** Who is over their request budget: an Api-wide middleware refuses an `x-limited` caller. */
class RateLimited extends Domain.Rejection("RateLimited") {}
class RateLimit extends RpcMiddleware.Service<RateLimit>()("Test/RateLimit", {
  error: RateLimited.pipe(HttpApiSchema.status(429)),
}) {}
const RateLimitLive = Layer.succeed(RateLimit, (effect, { headers }) =>
  Option.isSome(Headers.get(headers, "x-limited")) ? Effect.fail(new RateLimited()) : effect,
);
class LimitedApi extends Domain.Api("LimitedApi", Deposit, Wallet, Balance) {}
const Limited = LimitedApi.middleware(RateLimit);

/**
 * Publishes the deposit, the balance's reads and the wallet's events; the
 * wallet aggregate's `get` and `watch` and `Balance.list` stay off.
 */
const WalletHttp = DomainHttp.toHttpApi(WalletApi, {
  include: ["Deposit", "Balance.get", "Balance.snapshot", "Balance.watch", "Wallet.events"],
  status: { NotOwner: 403 },
});

/** The hosted model, its middleware, and an in-process Bun server with a client for it. */
const Hosted = Layer.mergeAll(SessionLive, RateLimitLive, Wallets.layer(Layer.empty)).pipe(
  Layer.provide(InMemory),
  Layer.provideMerge(BunHttpServer.layerTest),
);

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

const execute = (method: "GET" | "POST", path: string, options: SendOptions) =>
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

const send = (method: "GET" | "POST", path: string, options: SendOptions = {}) =>
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

describe("Domain toHttpApi", () => {
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
      // An aggregate's `read` middleware guards its events too.
      expect((yield* send("GET", "/Wallet/w-6/events")).status).toBe(401);
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
      const all = yield* listen("/Wallet/w-8/events", { owner: "kim" });
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
      const resumed = yield* listen(`/Wallet/w-8/events?after=${second.envelope.seq}`, {
        owner: "kim",
      });
      const tail = (yield* resumed.take(2)).map(({ data }) =>
        data._tag === "CaughtUp" ? "caught up" : data.event.amount,
      );
      expect(tail).toEqual([4, "caught up"]);
    }).pipe(Effect.provide(Served)),
  );

  it.live("middleware applied to the whole Api guards every endpoint, live reads included", () =>
    Effect.gen(function* () {
      const limited = { owner: "kim", headers: { "x-limited": "1" } };
      expect(
        yield* send("POST", "/Deposit", {
          ...limited,
          body: { target: "w-9", input: { amount: 1, at } },
        }),
      ).toEqual({ status: 429, body: { _tag: "RateLimited" } });
      expect(yield* send("GET", "/Balance/w-9/watch", limited)).toEqual({
        status: 429,
        body: { _tag: "RateLimited" },
      });
      // Without the header, the same calls go through.
      yield* send("POST", "/Deposit", {
        owner: "kim",
        body: { target: "w-9", input: { amount: 1, at } },
      });
      const watch = yield* listen("/Balance/w-9/watch", { owner: "kim" });
      expect(watch.status).toBe(200);
      expect((yield* watch.take(1))[0]!.data.state).toEqual({ owner: "kim", balance: 1 });
    }).pipe(
      Effect.provide(
        (() => {
          const LimitedHttp = DomainHttp.toHttpApi(Limited, {
            include: ["Deposit", "Balance.watch"],
          });
          return serve(LimitedHttp.api, LimitedHttp.layer);
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

  it.live("an operation left out of include is not served", () =>
    Effect.gen(function* () {
      expect((yield* send("GET", "/Wallet/w-1", { owner: "sam" })).status).toBe(404);
      expect((yield* send("GET", "/Wallet/w-1/watch", { owner: "sam" })).status).toBe(404);
      expect((yield* send("GET", "/Balance/w-1/list", { owner: "sam" })).status).toBe(404);
      expect(Object.keys(WalletHttp.group.endpoints)).toEqual([
        "Deposit",
        "Wallet.events",
        "Balance.get",
        "Balance.watch",
        "Balance.snapshot",
      ]);
    }).pipe(Effect.provide(Served)),
  );

  it("the OpenAPI document lists each endpoint with its schemas", () => {
    const spec = OpenApi.fromApi(WalletHttp.api);
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/Balance/{key}",
      "/Balance/{key}/snapshot",
      "/Balance/{key}/watch",
      "/Deposit",
      "/Wallet/{key}/events",
    ]);

    const deposit = spec.paths["/Deposit"]!.post!;
    expect(deposit.operationId).toBe("WalletApi.Deposit");
    const body = JSON.stringify(deposit.requestBody);
    for (const field of ["target", "amount", "at", "commandId"]) expect(body).toContain(field);
    expect(Object.keys(deposit.responses).sort()).toEqual(["200", "401", "422"]);
    expect(JSON.stringify(deposit.responses["422"])).toContain("OverLimit");

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
    const events = spec.paths["/Wallet/{key}/events"]!.get!;
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

  it("publishes every call of an entry, and refuses names it cannot serve", () => {
    const all = DomainHttp.toHttpApi(WalletApi, { include: ["Wallet", "Balance"] });
    expect(Object.values(all.group.endpoints).map((e) => [e.identifier, e.method, e.path])).toEqual(
      [
        ["Wallet.get", "GET", "/Wallet/:key"],
        ["Wallet.watch", "GET", "/Wallet/:key/watch"],
        ["Wallet.events", "GET", "/Wallet/:key/events"],
        ["Balance.get", "GET", "/Balance/:key"],
        ["Balance.watch", "GET", "/Balance/:key/watch"],
        ["Balance.events", "GET", "/Balance/:key/events"],
        ["Balance.list", "GET", "/Balance/:key/list"],
        ["Balance.snapshot", "GET", "/Balance/:key/snapshot"],
      ],
    );
  });

  it.live("a name the Api cannot serve fails the Layer with a DefinitionError", () =>
    Effect.gen(function* () {
      /** The defect building the surface's Layer dies with. */
      const defectOf = (surface: { readonly layer: Layer.Layer<any, never, any> }) =>
        Layer.build(surface.layer).pipe(
          Effect.provide(Hosted),
          Effect.scoped,
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
        );

      // @ts-expect-error not a call of the view.
      const peek = yield* defectOf(DomainHttp.toHttpApi(WalletApi, { include: ["Balance.peek"] }));
      expect(peek).toMatchObject({
        _tag: "DefinitionError",
        message: "WalletApi has no entry or call named Balance.peek",
      });
      // @ts-expect-error not an entry of the Api.
      const withdraw = yield* defectOf(DomainHttp.toHttpApi(WalletApi, { include: ["Withdraw"] }));
      expect(withdraw).toMatchObject({ _tag: "DefinitionError" });
      // A status for a failure no call declares is a typo.
      const typo = yield* defectOf(
        DomainHttp.toHttpApi(WalletApi, { include: ["Deposit"], status: { NotOwnr: 403 } }),
      );
      expect(typo).toMatchObject({
        _tag: "DefinitionError",
        message: "WalletApi has no typed failure named NotOwnr",
      });
      // `layerFor` an HttpApi that does not hold the group.
      const elsewhere = yield* defectOf({ layer: WalletHttp.layerFor(HttpApi.make("Elsewhere")) });
      expect(elsewhere).toMatchObject({ _tag: "DefinitionError" });
    }),
  );
});
