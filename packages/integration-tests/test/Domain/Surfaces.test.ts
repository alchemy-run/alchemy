import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import * as Surfaces from "@alchemy.run/domain/Surfaces";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- a wallet domain

const WalletId = Schema.String.pipe(Schema.brand("WalletId"));

class Owner extends Domain.RequestContext<Owner>()("Test/Owner", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Session extends RpcMiddleware.Service<Session, { provides: Owner }>()("Test/Session", {
  error: Unauthenticated,
}) {}
/** A bearer token names the owner; no token, no session. */
const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (value) => Effect.provideService(effect, Owner, value.replace(/^Bearer /, "")),
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
  // `at` is a transform: an ISO string on the wire, a DateTime in `decide`.
  input: { amount: Schema.Int, at: Schema.DateTimeUtc },
  events: [Deposited],
  rejects: [OverLimit],
  reply: { balance: Schema.Int, at: Schema.DateTimeUtc },
}) {}

class Wallet extends Domain.Aggregate("Wallet", {
  id: WalletId,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: {
    Deposit: Effect.fn(function* (_, cmd) {
      if (cmd.amount > 100) return yield* new OverLimit({ limit: 100 });
      return [new Deposited({ owner: yield* Owner, amount: cmd.amount, at: cmd.at })];
    }),
  },
  evolve: { Deposited: (s, e) => ({ balance: s.balance + e.amount }) },
  reply: { Deposit: (s, [deposited]) => ({ balance: s.balance, at: deposited!.at }) },
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

class Wallets extends Domain.Model("SurfaceWallets", {
  aggregates: [Wallet],
  views: [Balance],
}) {}
class WalletApi extends Domain.Api("WalletApi", Deposit, Wallet, Balance) {}

/** The hosted model and its session middleware: each surface gets its own. */
const WalletsLive = Layer.mergeAll(Wallets.layer(Layer.empty), SessionLive).pipe(
  Layer.provide(InMemory),
);

const parity = Surfaces.make(WalletApi, { layer: WalletsLive });

const sam = { authorization: "Bearer sam" };
const kim = { authorization: "Bearer kim" };
const at = "2026-10-25T12:00:00.000Z";

// ---------------------------------------------------------------- tests

describe("Domain Surfaces", () => {
  it.live("a scenario gives the same answers on every surface", () =>
    Effect.gen(function* () {
      const outcomes = yield* parity(
        { call: "Deposit", input: { target: "w-1", amount: 30, at }, headers: sam },
        { call: "Deposit", input: { target: "w-1", amount: 500, at }, headers: sam },
        { call: "Deposit", input: { target: "w-1", amount: 5, at } },
        { call: "Deposit", input: { target: "w-1", amount: "lots", at }, headers: sam },
        {
          call: "Balance.get",
          input: { key: "w-1", atLeast: { stream: "Wallet/w-1", version: 1 } },
          headers: sam,
        },
        { call: "Balance.get", input: { key: "w-1" }, headers: kim },
        { call: "Balance.get", input: { key: "w-9" }, headers: sam },
        { call: "Wallet.get", input: { key: "w-1" }, headers: sam },
        { call: "Wallet.get", input: { key: "w-1" } },
        {
          call: "Balance.list",
          input: { key: "w-1", order: "desc", take: 10 },
          headers: sam,
          // Envelopes carry the time of each world's commit: compare the events.
          select: (page) =>
            (page as { entries: ReadonlyArray<{ event: unknown }> }).entries.map((e) => e.event),
        },
      );
      expect(outcomes).toEqual([
        // A command's receipt, with the transform encoded back to its wire form.
        {
          _tag: "Success",
          value: { reply: { balance: 30, at }, stream: "Wallet/w-1", version: 1 },
        },
        // A rejection, with its data.
        { _tag: "Failure", error: { _tag: "OverLimit", limit: 100 } },
        // No session: the middleware refuses the call on every surface.
        { _tag: "Failure", error: { _tag: "Unauthenticated" } },
        // Input the schema refuses never reaches the model.
        { _tag: "Invalid" },
        { _tag: "Success", value: { owner: "sam", balance: 30 } },
        { _tag: "Failure", error: { _tag: "NotOwner" } },
        // An empty key is `null`, though tools wrap it as `{ value }`.
        { _tag: "Success", value: null },
        { _tag: "Success", value: { balance: 30 } },
        { _tag: "Failure", error: { _tag: "Unauthenticated" } },
        { _tag: "Success", value: [{ _tag: "Deposited", owner: "sam", amount: 30, at }] },
      ]);
    }),
  );

  it.live("fails with every surface's answer when one surface differs", () =>
    Effect.gen(function* () {
      // A session that reads a header only the MCP transport sends: the
      // middleware sees a different caller on one surface.
      const LeakyLive = Layer.mergeAll(
        Wallets.layer(Layer.empty),
        Layer.succeed(Session, (effect, { headers }) =>
          Effect.provideService(
            effect,
            Owner,
            Option.isSome(Headers.get(headers, "mcp-session-id")) ? "mcp" : "sam",
          ),
        ),
      ).pipe(Layer.provide(InMemory));
      const leaky = Surfaces.make(WalletApi, { layer: LeakyLive });
      const differ = yield* leaky(
        { call: "Deposit", input: { target: "w-1", amount: 30, at } },
        {
          call: "Balance.get",
          input: { key: "w-1", atLeast: { stream: "Wallet/w-1", version: 1 } },
        },
      ).pipe(Effect.flip);
      expect(differ._tag).toBe("SurfacesDiffer");
      expect(differ.step).toBe(2);
      expect(differ.call).toBe("Balance.get");
      expect(differ.outcomes.client).toEqual({
        _tag: "Success",
        value: { owner: "sam", balance: 30 },
      });
      expect(differ.outcomes.mcp).toEqual({
        _tag: "Success",
        value: { owner: "mcp", balance: 30 },
      });
      expect(differ.message).toContain("Step 2 (Balance.get)");
      expect(differ.message).toMatch(/mcp\s+Success \{"balance":30,"owner":"mcp"\}/);
    }),
  );

  it.live("compares only the surfaces it is given; the first is the reference", () =>
    Effect.gen(function* () {
      const twoSurfaces = Surfaces.make(WalletApi, {
        layer: WalletsLive,
        surfaces: ["http", "cli"],
      });
      const [receipt] = yield* twoSurfaces({
        call: "Deposit",
        input: { target: "w-2", amount: 7, at, commandId: "c-1" },
        headers: kim,
      });
      expect(receipt).toEqual({
        _tag: "Success",
        value: { reply: { balance: 7, at }, stream: "Wallet/w-2", version: 1 },
      });
      expect(Surfaces.all).toEqual(["client", "toolkit", "mcp", "http", "cli"]);
    }),
  );

  it("names only the Api's request/response calls", () => {
    // Type checks only: each throws when the scenario is built.
    const _stream = () =>
      // @ts-expect-error `watch` is a stream, on no surface but the Api's own clients.
      parity({ call: "Balance.watch", input: { key: "w-1" } });
    const _unknown = () =>
      // @ts-expect-error not an entry of the Api.
      parity({ call: "Withdraw", input: {} });
    expect(_stream).toThrow("Balance.watch is a stream");
    expect(_unknown).toThrow("Withdraw");
    expect(() => parity({ call: "Wallet.list" as never, input: { key: "w-1" } })).toThrow(
      "Wallet.list",
    );
  });
});
