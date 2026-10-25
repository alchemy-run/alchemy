import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

// ---------------------------------------------------------------- a wallet domain

class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { owner: Schema.String },
  events: [Opened],
}) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amounts: Schema.Array(Schema.Number) },
  events: [Deposited],
}) {}
class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ owner: Schema.NullOr(Schema.String) }),
  initial: { owner: null },
  commands: [Open, Deposit],
  decide: {
    Open: (_, { owner }) => [new Opened({ owner })],
    // One deposit per amount: a command can record many events.
    Deposit: (_, { amounts }) => amounts.map((amount) => new Deposited({ amount })),
  },
  evolve: { Opened: (_, e) => ({ owner: e.owner }), Deposited: (s) => s },
}) {}

/** Who owns each wallet, for `validate` to read. */
class WalletOwner extends Domain.View("WalletOwner", {
  from: [Wallet],
  key: Wallet,
  state: Schema.Struct({ owner: Schema.String }),
  initial: { owner: "" },
  evolve: { Opened: (_, e) => ({ owner: e.owner }) },
}) {}

// ---------------------------------------------------------------- a store the projection writes

const Movement = Schema.Struct({
  id: Schema.String,
  wallet: Schema.String,
  owner: Schema.String,
  amount: Schema.Number,
});
type Movement = typeof Movement.Type;

/** A table outside the model, keyset-paged by id. */
class Movements extends Context.Service<
  Movements,
  {
    readonly upsert: (rows: ReadonlyArray<Movement>) => Effect.Effect<void>;
    readonly page: (
      where: (row: Movement) => boolean,
      page: Domain.Query.PageRequest,
    ) => Effect.Effect<Domain.View.Page<Movement>>;
  }
>()("Test/Movements") {
  static readonly memory = Layer.effect(
    Movements,
    Effect.gen(function* () {
      const table = yield* Ref.make(new Map<string, Movement>());
      return {
        upsert: (rows) =>
          Ref.update(table, (map) => {
            const next = new Map(map);
            for (const row of rows) next.set(row.id, row);
            return next;
          }),
        page: (where, { after, take }) =>
          Ref.get(table).pipe(
            Effect.map((map) => {
              const rows = [...map.values()]
                .filter((row) => where(row) && (after === undefined || row.id > after))
                .sort((a, b) => (a.id < b.id ? -1 : 1));
              const entries = rows.slice(0, take);
              return {
                entries,
                cursor: rows.length > take ? entries[entries.length - 1]!.id : null,
              };
            }),
          ),
      };
    }),
  );
}

class Ledger extends Domain.Projection("Ledger", {
  from: [Wallet],
  key: Wallet,
  on: [Deposited],
}) {}
const ledgerLayer = (options?: Domain.Projection.Options) =>
  Ledger.toLayer(
    Effect.gen(function* () {
      const movements = yield* Movements;
      return Effect.fn(function* (batch) {
        yield* movements.upsert(
          batch.map(({ key, event, envelope }) => ({
            id: `${envelope.stream}:${String(envelope.seq).padStart(4, "0")}`,
            wallet: key.id,
            owner: key.id.split("-")[0]!,
            amount: event.amount,
          })),
        );
      });
    }),
    options,
  );

// ---------------------------------------------------------------- who is asking

class Viewer extends Domain.RequestContext<Viewer>()("Test/QueryViewer", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class NotYours extends Domain.Rejection("NotYours", { wallet: Schema.String }) {}
class ViewerSession extends RpcMiddleware.Service<ViewerSession, { provides: Viewer }>()(
  "Test/QueryViewerSession",
  { error: Unauthenticated },
) {}
const ViewerSessionLive = Layer.succeed(ViewerSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-viewer"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (name) => Effect.provideService(effect, Viewer, name),
  }),
);

// ---------------------------------------------------------------- the queries

/** One wallet's movements, for its owner: authorized per request. */
class WalletMovements extends Domain.Query("WalletMovements", {
  input: { wallet: Schema.String },
  row: Movement,
  from: [Ledger],
  middleware: [ViewerSession],
  rejects: [NotYours],
  take: { default: 2, max: 3 },
  validate: Effect.fn(function* ({ wallet }) {
    const viewer = yield* Viewer;
    const owners = yield* WalletOwner;
    const owner = Option.getOrNull(yield* owners.query(Wallet.ref(wallet)).pipe(Effect.orDie));
    if (owner && owner.owner !== viewer) return yield* new NotYours({ wallet });
  }),
}) {}
const WalletMovementsLive = WalletMovements.toLayer(
  Effect.gen(function* () {
    const movements = yield* Movements;
    return ({ wallet }, page) => movements.page((row) => row.wallet === wallet, page);
  }),
);

/** Large movements across every wallet: each row judged on its own. */
class LargeMovements extends Domain.Query("LargeMovements", {
  input: { min: Schema.Number, note: Schema.Redacted(Schema.String) },
  row: Movement,
  middleware: [ViewerSession],
  attributes: (input) => ({ "query.min": input.min, "query.note": input.note }),
  visible: Effect.fn(function* (row) {
    return row.owner === (yield* Viewer);
  }),
}) {}
// Forgets to scope by the viewer: `visible` still keeps other owners' rows out.
const LargeMovementsLive = LargeMovements.toLayer(
  Effect.gen(function* () {
    const movements = yield* Movements;
    return ({ min }, page) => movements.page((row) => row.amount >= min, page);
  }),
);

/** A single result, not paged. */
class Total extends Domain.Query("Total", {
  input: { wallet: Schema.String },
  success: Schema.Struct({ total: Schema.Number, movements: Schema.Number }),
  from: [Ledger],
}) {}
const TotalLive = Total.toLayer(
  Effect.gen(function* () {
    const movements = yield* Movements;
    return ({ wallet }) =>
      movements
        .page((row) => row.wallet === wallet, { after: undefined, take: 1_000 })
        .pipe(
          Effect.map(({ entries }) => ({
            total: entries.reduce((sum, row) => sum + row.amount, 0),
            movements: entries.length,
          })),
        );
  }),
);

class Wallets extends Domain.Model("QueryWallets", {
  aggregates: [Wallet],
  views: [WalletOwner],
  projections: [Ledger],
  queries: [WalletMovements, LargeMovements, Total],
}) {}

class WalletApi extends Domain.Api(
  "QueryWalletApi",
  Deposit,
  WalletMovements,
  LargeMovements,
  Total,
) {}

const handlers = (options?: Domain.Projection.Options) =>
  Layer.mergeAll(ledgerLayer(options), WalletMovementsLive, LargeMovementsLive, TotalLive);

const story = Story.make(Wallets, { layer: handlers() });
const sam = Wallet.ref("sam-1");
const kim = Wallet.ref("kim-1");
const asSam = Story.provide(Viewer, "sam");
const asKim = Story.provide(Viewer, "kim");

/** A tracer that keeps every span it starts. */
const recording = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer, named: (name: string) => spans.filter((span) => span.name === name) };
};

describe("Domain Query", () => {
  it.effect("reads rows a projection wrote, and refuses who validate refuses", () =>
    story(
      Story.given(sam, new Opened({ owner: "sam" })),
      Story.when(sam, new Deposit({ amounts: [10, 20] })),
      asSam,
      Story.query(WalletMovements, { wallet: "sam-1" }, [{ amount: 10 }, { amount: 20 }]),
      asKim,
      Story.query(WalletMovements, { wallet: "sam-1" }),
      Story.rejected(new NotYours({ wallet: "sam-1" })),
    ).pipe(Effect.provide(Movements.memory)),
  );

  it.effect("pages by cursor, and clamps take to the declared maximum", () =>
    story(
      Story.given(sam, new Opened({ owner: "sam" })),
      Story.when(sam, new Deposit({ amounts: [1, 2, 3, 4, 5] })),
      asSam,
      // The default page size.
      Story.query(WalletMovements, { wallet: "sam-1" }, (page) => {
        expect(page.entries.map((row) => row.amount)).toEqual([1, 2]);
        expect(page.cursor).toBe("Wallet/sam-1:0003");
      }),
      Story.query(WalletMovements, { wallet: "sam-1" }, [{ amount: 3 }, { amount: 4 }], {
        after: "Wallet/sam-1:0003",
      }),
      // Asking for 10 gets at most 3.
      Story.query(
        WalletMovements,
        { wallet: "sam-1" },
        (page) => {
          expect(page.entries).toHaveLength(3);
          expect(page.cursor).not.toBeNull();
        },
        { take: 10 },
      ),
    ).pipe(Effect.provide(Movements.memory)),
  );

  it.effect("visible keeps rows the caller may not see out of a cross-key result", () =>
    Effect.gen(function* () {
      const { tracer, named } = recording();
      yield* story(
        Story.when(sam, new Deposit({ amounts: [500, 5] })),
        Story.when(kim, new Deposit({ amounts: [700] })),
        asSam,
        Story.query(LargeMovements, { min: 100, note: Redacted.make("audit") }, [
          { wallet: "sam-1", amount: 500 },
        ]),
      ).pipe(Effect.provide(Movements.memory), Effect.withTracer(tracer));
      const [span] = named("Domain.query LargeMovements");
      expect(span!.attributes.get("domain.query.rows")).toBe(1);
      expect(span!.attributes.get("domain.query.hidden")).toBe(1);
      expect(span!.attributes.get("domain.outcome")).toBe("ok");
      // Only what `attributes` returns is recorded, and a Redacted value never is.
      expect(span!.attributes.get("query.min")).toBe(100);
      expect(span!.attributes.get("query.note")).toBe("<redacted>");
      expect([...span!.attributes.keys()].some((key) => key.includes("wallet"))).toBe(false);
    }),
  );

  it.effect("answers a single result", () =>
    story(
      Story.when(sam, new Deposit({ amounts: [10, 32] })),
      Story.query(Total, { wallet: "sam-1" }, { total: 42, movements: 2 }),
    ).pipe(Effect.provide(Movements.memory)),
  );

  it.effect("a story fails on a query rejection no step asserts", () =>
    story(
      Story.given(sam, new Opened({ owner: "sam" })),
      asKim,
      Story.query(WalletMovements, { wallet: "sam-1" }),
    ).pipe(
      Effect.provide(Movements.memory),
      Effect.flip,
      Effect.map((failure) =>
        expect(failure.reason).toBe(
          "the query WalletMovements was rejected with NotYours, which no step asserts",
        ),
      ),
    ),
  );

  it.effect("a story shows the rows it expected and the rows it got", () =>
    story(
      Story.when(sam, new Deposit({ amounts: [10] })),
      asSam,
      Story.query(WalletMovements, { wallet: "sam-1" }, [{ amount: 11 }]),
    ).pipe(
      Effect.provide(Movements.memory),
      Effect.flip,
      Effect.map((failure) => {
        expect(failure.step).toBe(3);
        expect(failure.message).toContain("expected { amount: 11 }");
        expect(failure.message).toContain('got      { id: "Wallet/sam-1:0001"');
      }),
    ),
  );

  it.live("serves queries through an Api: typed results, rejections and read-your-writes", () =>
    Effect.gen(function* () {
      const wallets = yield* Wallet;
      yield* wallets.send(sam, new Open({ owner: "sam" }));
      const api = yield* WalletApi.testClient;
      const asSam = { headers: { "x-viewer": "sam" } };
      // The projection batches for 200ms; `atLeast` waits for it, through a
      // command with more events than the first window reads.
      const amounts = Array.from({ length: 20 }, (_, i) => i + 1);
      const receipt = yield* api.Deposit({ target: "sam-1", amounts });
      const total = yield* api.Total({ wallet: "sam-1" }, { ...asSam, atLeast: receipt });
      expect(total).toEqual({ total: 210, movements: 20 });

      const page = yield* api.WalletMovements(
        { wallet: "sam-1" },
        { ...asSam, atLeast: receipt, take: 3 },
      );
      expect(page.entries.map((row) => row.amount)).toEqual([1, 2, 3]);
      const next = yield* api.WalletMovements(
        { wallet: "sam-1" },
        { ...asSam, after: page.cursor!, take: 3 },
      );
      expect(next.entries.map((row) => row.amount)).toEqual([4, 5, 6]);

      const refused = yield* api
        .WalletMovements({ wallet: "sam-1" }, { headers: { "x-viewer": "kim" } })
        .pipe(Effect.flip);
      expect(refused).toEqual(new NotYours({ wallet: "sam-1" }));
      const anonymous = yield* api.WalletMovements({ wallet: "sam-1" }).pipe(Effect.flip);
      expect(anonymous._tag).toBe("Unauthenticated");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Wallets.layer(handlers({ batch: { size: 100, wait: "200 millis" } })).pipe(
          Layer.provideMerge(Layer.mergeAll(InMemory, Movements.memory, ViewerSessionLive)),
        ),
      ),
    ),
  );

  it.live("a projection catches up to a client's receipt, which carries no events", () =>
    Effect.gen(function* () {
      const wallets = yield* Wallet;
      const receipt = yield* wallets.send(kim, new Deposit({ amounts: [1, 2, 3] }));
      yield* Ledger.caughtUp({ stream: receipt.stream, version: receipt.version });
      const movements = yield* Movements;
      const { entries } = yield* movements.page(() => true, { after: undefined, take: 10 });
      expect(entries.map((row) => row.amount)).toEqual([1, 2, 3]);
      // A version beyond the instance's is clamped, and an unknown stream waits for nothing.
      yield* Ledger.caughtUp({ stream: receipt.stream, version: 1_000 });
      yield* Ledger.caughtUp({ stream: "Nobody/n-1", version: 3 });
    }).pipe(
      Effect.provide(
        Wallets.layer(handlers({ batch: { size: 100, wait: "100 millis" } })).pipe(
          Layer.provideMerge(Layer.mergeAll(InMemory, Movements.memory)),
        ),
      ),
    ),
  );

  it.effect("a query that reads projections declares ConsistencyTimeout on the wire", () =>
    Effect.sync(() => {
      const timeout = new Domain.ConsistencyTimeout({
        view: "Ledger",
        key: "sam-1",
        stream: "Wallet/sam-1",
        version: 3,
      });
      const errorsOf = (query: Domain.Query.Any) =>
        Schema.is((query.rpc as Rpc.AnyWithProps).errorSchema);
      expect(errorsOf(Total)(timeout)).toBe(true);
      expect(errorsOf(LargeMovements)(timeout)).toBe(false);
    }),
  );

  it.effect("counts queries by outcome", () =>
    Effect.gen(function* () {
      const refused = Metric.withAttributes(Domain.Telemetry.queries, {
        "domain.query": "WalletMovements",
        "domain.outcome": "NotYours",
      });
      const before = (yield* Metric.value(refused)).count;
      yield* story(
        Story.given(sam, new Opened({ owner: "sam" })),
        asKim,
        Story.query(WalletMovements, { wallet: "sam-1" }),
        Story.rejected(new NotYours({ wallet: "sam-1" })),
      ).pipe(Effect.provide(Movements.memory));
      expect((yield* Metric.value(refused)).count).toBe(before + 1);
    }),
  );

  it("refuses a query that reads from a projection the model doesn't host", () => {
    class Lonely extends Domain.Model("QueryLonely", {
      aggregates: [Wallet],
      views: [WalletOwner],
      queries: [Total],
    }) {}
    const exit = Effect.runSyncExit(
      Layer.build(Lonely.layer(Layer.provide(TotalLive, Movements.memory))).pipe(
        Effect.scoped,
        Effect.provide(InMemory),
      ) as Effect.Effect<unknown>,
    );
    expect(String(exit)).toContain("Total reads from Ledger, which is not in the Domain");
  });

  it("refuses an Api with two entries of one name", () => {
    class Deposit2 extends Domain.Query("Deposit", { success: Schema.Number }) {}
    expect(() => Domain.Api("Twice", Deposit, Deposit2)).toThrow(
      "Api 'Twice' exposes two entries named 'Deposit'",
    );
  });
});
