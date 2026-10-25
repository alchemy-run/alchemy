import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Platform, type Subscription } from "@alchemy.run/domain/Platform";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerRequestModule from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// ---------------------------------------------------------------- who is asking

class Member extends Domain.RequestContext<Member>()(
  "Access/Member",
  Schema.Struct({ name: Schema.String, role: Schema.Literals(["teller", "customer"]) }),
) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Session extends RpcMiddleware.Service<Session, { provides: Member }>()("Access/Session", {
  error: Unauthenticated,
}) {}
/** How many times the session middleware ran. */
let sessions = 0;
/** `x-member: ann:teller` signs in as ann, a teller. No header, no session. */
const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-member"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (member) => {
      sessions++;
      const [name, role] = member.split(":") as [string, "teller" | "customer"];
      return Effect.provideService(effect, Member, { name, role });
    },
  }),
);

class TellersOnly extends Domain.Rejection("TellersOnly") {}
/** Who `access` saw, to prove it reads what the middleware provides. */
const seen: Array<string> = [];
const tellersOnly = Effect.gen(function* () {
  const member = yield* Member;
  seen.push(member.name);
  if (member.role !== "teller") return yield* new TellersOnly();
});

// ---------------------------------------------------------------- an account domain

class Opened extends Domain.Event("Opened") {}
class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Closed extends Domain.Event("Closed") {}

/** Anyone may open an account: no middleware, no access check. */
class Open extends Domain.Command("Open", { target: Schema.String, events: [Opened] }) {}
/** Any member may deposit: middleware, no access check. */
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  middleware: [Session],
  input: { amount: Schema.Number },
  events: [Deposited],
}) {}
/** Only a teller may close an account. */
class Close extends Domain.Command("Close", {
  target: Schema.String,
  middleware: [Session],
  events: [Closed],
  rejects: [TellersOnly],
  access: tellersOnly,
}) {}

/** How many times `decide` ran for `Close`. */
let closesDecided = 0;

class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number, closed: Schema.Boolean }),
  initial: { balance: 0, closed: false },
  commands: [Open, Deposit, Close],
  decide: {
    Open: () => [new Opened()],
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
    Close: () => {
      closesDecided++;
      return [new Closed()];
    },
  },
  evolve: {
    Opened: (s) => s,
    Deposited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Closed: (s) => ({ ...s, closed: true }),
  },
  read: { middleware: [Session], rejects: [TellersOnly], access: tellersOnly },
}) {}

/** Every member may read a balance. */
class Balance extends Domain.View("Balance", {
  from: [Account],
  key: Account,
  middleware: [Session],
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
}) {}

/** Only tellers may read the audit view. */
class Audit extends Domain.View("Audit", {
  from: [Account],
  key: Account,
  middleware: [Session],
  rejects: [TellersOnly],
  access: tellersOnly,
  state: Schema.Struct({ deposits: Schema.Number }),
  initial: { deposits: 0 },
  evolve: { Deposited: (s) => ({ deposits: s.deposits + 1 }) },
}) {}

/** Only tellers may read the ledger. */
class Ledger extends Domain.Stream("Ledger", {
  key: Account,
  entries: [Deposited],
  middleware: [Session],
  rejects: [TellersOnly],
  access: tellersOnly,
}) {}

class Bank extends Domain.Model("AccessBank", {
  aggregates: [Account],
  views: [Balance, Audit],
  streams: [Ledger],
}) {}

class BankApi extends Domain.Api(
  "BankApi",
  Open,
  Deposit,
  Close,
  Account,
  Balance,
  Audit,
  Ledger,
) {}

const as = (member?: string) => ({
  headers: Headers.fromInput(member ? { "x-member": member } : {}),
});
const ann = as("ann:teller");
const bob = as("bob:customer");

const nameOf = (entry: Domain.Api.Entry) =>
  entry.kind === "Command"
    ? entry.tag
    : entry.kind === "View"
      ? entry.viewName
      : entry.kind === "Stream"
        ? entry.streamName
        : entry.aggregateName;

const visibleTo = (member?: string) =>
  BankApi.visible(as(member)).pipe(Effect.map((entries) => entries.map(nameOf)));

const BankLive = Layer.mergeAll(SessionLive, Bank.layer(Layer.empty)).pipe(Layer.provide(InMemory));

describe("Domain access", () => {
  it.live("visible lists the entries each caller may use", () =>
    Effect.gen(function* () {
      expect(yield* visibleTo("ann:teller")).toEqual([
        "Open",
        "Deposit",
        "Close",
        "Account",
        "Balance",
        "Audit",
        "Ledger",
      ]);
      expect(yield* visibleTo("bob:customer")).toEqual(["Open", "Deposit", "Balance"]);
      // A middleware failure hides its entries; it does not fail the list.
      expect(yield* visibleTo()).toEqual(["Open"]);
    }).pipe(Effect.provide(BankLive)),
  );

  it.live("access reads what the entry's middleware provides", () =>
    Effect.gen(function* () {
      seen.length = 0;
      yield* BankApi.visible(as("cleo:teller"));
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set(["cleo"]));
    }).pipe(Effect.provide(BankLive)),
  );

  it.live("visible runs each middleware stack once, not once per entry", () =>
    Effect.gen(function* () {
      sessions = 0;
      seen.length = 0;
      yield* BankApi.visible(ann);
      // Six entries declare `[Session]`: one session, then each entry's access.
      expect(sessions).toBe(1);
      expect(seen).toEqual(["ann", "ann", "ann", "ann"]);
    }).pipe(Effect.provide(BankLive)),
  );

  it.live("a denied command fails with the declared rejection and never reaches decide", () =>
    Effect.gen(function* () {
      const client = yield* BankApi.testClient;
      yield* client.Open({ target: "a-1" });
      closesDecided = 0;
      const denied = yield* client.Close({ target: "a-1" }, bob).pipe(Effect.flip);
      expect(denied._tag).toBe("TellersOnly");
      expect(closesDecided).toBe(0);
      expect((yield* client.Account.get("a-1", ann)).closed).toBe(false);

      const closed = yield* client.Close({ target: "a-1" }, ann);
      expect(closed.version).toBe(2);
      expect(closesDecided).toBe(1);
      expect((yield* client.Account.get("a-1", ann)).closed).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BankLive)),
  );

  it.live("a denied read fails with the declared rejection", () =>
    Effect.gen(function* () {
      const client = yield* BankApi.testClient;
      const receipt = yield* client.Deposit({ target: "a-2", amount: 5 }, bob);
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect((yield* client.Account.get("a-2", bob).pipe(Effect.flip))._tag).toBe("TellersOnly");
      expect((yield* client.Audit.get("a-2", bob).pipe(Effect.flip))._tag).toBe("TellersOnly");
      expect((yield* client.Ledger.peek("a-2", bob).pipe(Effect.flip))._tag).toBe("TellersOnly");
      expect((yield* client.Ledger.list("a-2", bob).pipe(Effect.flip))._tag).toBe("TellersOnly");
      const watch = yield* client.Audit.watch("a-2", bob).pipe(Stream.runCollect, Effect.flip);
      expect(watch._tag).toBe("TellersOnly");
      const events = yield* client.Account.events("a-2", bob).pipe(Stream.runCollect, Effect.flip);
      expect(events._tag).toBe("TellersOnly");

      expect(yield* client.Audit.get("a-2", { ...ann, atLeast })).toEqual({ deposits: 1 });
      expect((yield* client.Account.get("a-2", ann)).balance).toBe(5);
      expect(yield* client.Ledger.peek("a-2", ann)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(BankLive)),
  );

  it.live("entries without access work as before", () =>
    Effect.gen(function* () {
      const client = yield* BankApi.testClient;
      yield* client.Open({ target: "a-3" });
      const receipt = yield* client.Deposit({ target: "a-3", amount: 7 }, bob);
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(yield* client.Balance.get("a-3", { ...bob, atLeast })).toEqual({ balance: 7 });
      const anonymous = yield* client.Deposit({ target: "a-3", amount: 1 }).pipe(Effect.flip);
      expect(anonymous._tag).toBe("Unauthenticated");
    }).pipe(Effect.scoped, Effect.provide(BankLive)),
  );

  it("access may fail only with declared rejections and read only what middleware provides", () => {
    class Undeclared extends Domain.Rejection("Undeclared") {}
    class NoSession extends Domain.Command("NoSession", {
      target: Schema.String,
      rejects: [TellersOnly],
      // @ts-expect-error: no middleware provides Member
      access: tellersOnly,
    }) {}
    class WrongRejection extends Domain.Command("WrongRejection", {
      target: Schema.String,
      middleware: [Session],
      rejects: [TellersOnly],
      // @ts-expect-error: Undeclared is not in rejects
      access: Effect.fail(new Undeclared()),
    }) {}
    class WrongRead extends Domain.View("WrongRead", {
      from: [Account],
      key: Account,
      middleware: [Session],
      // @ts-expect-error: TellersOnly is not in rejects
      access: tellersOnly,
    }) {}
    expect([NoSession.access, WrongRejection.access, WrongRead.definition.access]).toHaveLength(3);
  });

  it.live("a live read over a WebSocket is refused before it reaches the key", () =>
    Effect.gen(function* () {
      const subscriptions: Array<Subscription> = [];
      // Wrap the in-memory platform so views accept WebSocket upgrades.
      const Connecting = Layer.effect(
        Platform,
        Effect.map(Effect.service(Platform), (platform) =>
          Platform.of({
            ...platform,
            view: (view, kit) =>
              platform.view(view, kit).pipe(
                Effect.map((store) => ({
                  ...store,
                  connect: (_key: string, subscription: Subscription) =>
                    Effect.sync(() => {
                      subscriptions.push(subscription);
                      return HttpServerResponse.empty();
                    }),
                })),
              ),
          }),
        ),
      ).pipe(Layer.provide(InMemory));
      const open = (member: string) =>
        Effect.gen(function* () {
          const api = yield* BankApi;
          const read = { id: 1, tag: "Audit.watch", payload: { key: "a-4" } };
          const request = HttpServerRequestModule.fromWeb(
            new Request(`http://bank.test/api?read=${encodeURIComponent(JSON.stringify(read))}`, {
              headers: { upgrade: "websocket", "x-member": member },
            }),
          );
          yield* api.fetch.pipe(Effect.provideService(HttpServerRequest, request));
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(SessionLive, Bank.layer(Layer.empty)).pipe(Layer.provide(Connecting)),
          ),
        );

      yield* open("bob:customer");
      expect(subscriptions).toHaveLength(1);
      expect(JSON.stringify(subscriptions[0]!.refused)).toContain("TellersOnly");

      yield* open("ann:teller");
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions[1]!.refused).toBeUndefined();
      expect(Object.keys(subscriptions[1]!.context)).toEqual(["Access/Member"]);
    }),
  );
});
