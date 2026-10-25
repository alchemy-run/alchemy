import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Headers from "effect/http/Headers";
import * as HttpServer from "effect/http/HttpServer";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- a lock domain

class LockRegistered extends Domain.Event("LockRegistered", {
  org: Schema.String,
  name: Schema.String,
}) {}
class RegisterLock extends Domain.Command("RegisterLock", {
  target: Schema.String,
  input: { org: Schema.String, name: Schema.String },
  events: [LockRegistered],
}) {}
class LockNoted extends Domain.Event("LockNoted", { note: Schema.String }) {}
class NoteLock extends Domain.Command("NoteLock", {
  target: Schema.String,
  input: { note: Schema.String },
  events: [LockNoted],
}) {}
class Lock extends Domain.Aggregate("Lock", {
  id: Schema.String,
  state: Schema.Struct({ org: Schema.String, name: Schema.String }),
  initial: { org: "", name: "" },
  commands: [RegisterLock, NoteLock],
  decide: {
    RegisterLock: (_, { org, name }) => [new LockRegistered({ org, name })],
    NoteLock: (_, { note }) => [new LockNoted({ note })],
  },
  evolve: {
    LockRegistered: (_, { org, name }) => ({ org, name }),
    LockNoted: (s) => s,
  },
}) {}

// ---------------------------------------------------------------- a table the app owns

const LockRow = Schema.Struct({ id: Schema.String, org: Schema.String, name: Schema.String });
type LockRow = typeof LockRow.Type;

/** A table outside the model, standing in for a database. Writes wait for `gate`. */
class LockTable extends Context.Service<
  LockTable,
  {
    readonly upsert: (rows: ReadonlyArray<LockRow>) => Effect.Effect<void>;
    readonly search: (org: string, text?: string) => Effect.Effect<ReadonlyArray<LockRow>>;
    readonly gate: Latch.Latch;
  }
>()("Test/LockTable") {
  static readonly layer = (open = true) =>
    Layer.effect(
      LockTable,
      Effect.gen(function* () {
        const table = new Map<string, LockRow>();
        const gate = yield* Latch.make(open);
        return {
          upsert: (rows) =>
            gate.await.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  for (const row of rows) table.set(row.id, row);
                }),
              ),
            ),
          search: (org, text) =>
            Effect.sync(() =>
              [...table.values()]
                .filter((row) => row.org === org && (!text || row.name.includes(text)))
                .sort((a, b) => a.name.localeCompare(b.name)),
            ),
          gate,
        };
      }),
    );
}

class LockList extends Domain.Projection("LockList", {
  from: [Lock],
  key: Lock,
  on: [LockRegistered],
}) {}
const LockListLive = LockList.toLayer(
  Effect.gen(function* () {
    const table = yield* LockTable;
    return (batch) =>
      table.upsert(
        batch.map(({ key, event }) => ({ id: key.id, org: event.org, name: event.name })),
      );
  }),
);

class Locks extends Domain.Model("Locks", {
  aggregates: [Lock],
  projections: [LockList],
}) {}

// ---------------------------------------------------------------- who is asking

class Member extends Domain.RequestContext<Member>()("Test/Member", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class NotAMember extends Domain.Rejection("NotAMember", { org: Schema.String }) {}
class OrgSession extends RpcMiddleware.Service<OrgSession, { provides: Member }>()(
  "Test/OrgSession",
  { error: Unauthenticated },
) {}
const OrgSessionLive = Layer.succeed(OrgSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-org"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (org) => Effect.provideService(effect, Member, org),
  }),
);

// ---------------------------------------------------------------- the queries

class LockSearch extends Domain.Query("LockSearch", {
  projection: LockList,
  input: { org: Schema.String, text: Schema.optional(Schema.String) },
  output: Schema.Array(LockRow),
}) {}
const LockSearchLive = LockSearch.toLayer(
  Effect.gen(function* () {
    const table = yield* LockTable;
    return ({ org, text }) => table.search(org, text);
  }),
);

// Guarded: only a member of the org may list its locks.
class MyLocks extends Domain.Query("MyLocks", {
  projection: LockList,
  input: { org: Schema.String },
  output: Schema.Array(LockRow),
  middleware: [OrgSession],
  rejects: [NotAMember],
}) {}
const MyLocksLive = MyLocks.toLayer(
  Effect.gen(function* () {
    const table = yield* LockTable;
    return Effect.fn(function* ({ org }) {
      if ((yield* Member) !== org) return yield* new NotAMember({ org });
      return yield* table.search(org);
    });
  }),
);

class AccessApi extends Domain.Api("AccessApi", RegisterLock, NoteLock, LockSearch, MyLocks) {}

const world = (open = true) =>
  Layer.mergeAll(LockSearchLive, MyLocksLive, OrgSessionLive).pipe(
    Layer.provideMerge(Locks.layer(LockListLive)),
    Layer.provideMerge(Layer.mergeAll(InMemory, LockTable.layer(open))),
  );

const acme = (name: string) => ({ id: `acme-${name}`, org: "acme", name });

describe("Domain Query", () => {
  it.live("reads a projection's store through the Api", () =>
    Effect.gen(function* () {
      const api = yield* AccessApi.testClient;
      for (const [id, org, name] of [
        ["acme-front", "acme", "front"],
        ["acme-back", "acme", "back"],
        ["globex-gate", "globex", "gate"],
      ] as const) {
        yield* LockList.caughtUp(yield* (yield* Lock).send(id, new RegisterLock({ org, name })));
      }
      expect(yield* api.LockSearch({ org: "acme" })).toEqual([acme("back"), acme("front")]);
      expect(yield* api.LockSearch({ org: "acme", text: "fr" })).toEqual([acme("front")]);
      expect(yield* api.LockSearch({ org: "initech" })).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("atLeast waits until the projection has applied a write", () =>
    Effect.gen(function* () {
      const api = yield* AccessApi.testClient;
      const table = yield* LockTable;
      const receipt = yield* api.RegisterLock({ target: "acme-front", org: "acme", name: "front" });
      // The projection cannot write yet: a read without atLeast does not see the lock.
      expect(yield* api.LockSearch({ org: "acme" })).toEqual([]);
      const waiting = yield* api
        .LockSearch({ org: "acme" }, { atLeast: receipt })
        .pipe(Effect.forkChild);
      yield* Effect.sleep("50 millis");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* table.gate.open;
      expect(yield* Fiber.join(waiting)).toEqual([acme("front")]);
    }).pipe(Effect.scoped, Effect.provide(world(false))),
  );

  it.live("atLeast a write the projection does not consume returns at once", () =>
    Effect.gen(function* () {
      const api = yield* AccessApi.testClient;
      const table = yield* LockTable;
      yield* table.gate.open;
      const registered = yield* api.RegisterLock({
        target: "acme-front",
        org: "acme",
        name: "front",
      });
      yield* api.LockSearch({ org: "acme" }, { atLeast: registered });
      yield* table.gate.close;
      // LockList ignores LockNoted, so there is nothing to wait for after the registration.
      const noted = yield* api.NoteLock({ target: "acme-front", note: "battery low" });
      expect(noted.version).toBe(registered.version + 1);
      expect(yield* api.LockSearch({ org: "acme" }, { atLeast: noted })).toEqual([acme("front")]);
    }).pipe(Effect.scoped, Effect.provide(world(false))),
  );

  it.live("atLeast fails when the projection does not catch up in time", () =>
    Effect.gen(function* () {
      const progress = yield* LockList.Progress;
      const receipt = yield* (yield* Lock).send(
        "acme-front",
        new RegisterLock({ org: "acme", name: "front" }),
      );
      const timeout = yield* progress
        .caughtUp({ stream: receipt.stream, version: receipt.version }, { timeout: "100 millis" })
        .pipe(Effect.flip);
      expect(timeout).toMatchObject({ _tag: "ConsistencyTimeout", key: "acme-front" });
    }).pipe(Effect.scoped, Effect.provide(world(false))),
  );

  it.live("runs the query's middleware, and the handler reads what it provides", () =>
    Effect.gen(function* () {
      const api = yield* AccessApi.testClient;
      const receipt = yield* api.RegisterLock({ target: "acme-front", org: "acme", name: "front" });
      const asAcme = { headers: Headers.fromInput({ "x-org": "acme" }), atLeast: receipt };
      expect(yield* api.MyLocks({ org: "acme" }, asAcme)).toEqual([acme("front")]);
      const refused = yield* api.MyLocks({ org: "globex" }, asAcme).pipe(Effect.flip);
      expect(refused).toEqual(new NotAMember({ org: "globex" }));
      const anonymous = yield* api.MyLocks({ org: "acme" }).pipe(Effect.flip);
      expect(anonymous._tag).toBe("Unauthenticated");
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("round-trips over HTTP", () =>
    Effect.gen(function* () {
      const api = yield* AccessApi.client;
      const receipt = yield* api.RegisterLock({ target: "acme-front", org: "acme", name: "front" });
      expect(yield* api.LockSearch({ org: "acme" }, { atLeast: receipt })).toEqual([acme("front")]);
      const refused = yield* api
        .MyLocks({ org: "acme" }, { headers: Headers.fromInput({ "x-org": "globex" }) })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("NotAMember");
    }).pipe(
      Effect.provide(
        Domain.protocolHttp("").pipe(
          Layer.provideMerge(
            Layer.unwrap(Effect.map(AccessApi, (api) => HttpServer.serve()(api.fetch))).pipe(
              Layer.provideMerge(NodeHttpServer.layerTest),
              Layer.provide(world()),
            ),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.live("an Api refuses a query whose projection the model does not host", () =>
    Effect.gen(function* () {
      class Bare extends Domain.Model("Bare", { aggregates: [Lock] }) {}
      class SearchApi extends Domain.Api("SearchApi", LockSearch) {}
      const exit = yield* SearchApi.testClient.pipe(
        Effect.provide(
          LockSearchLive.pipe(
            Layer.provideMerge(Bare.layer(Layer.empty)),
            Layer.provideMerge(Layer.mergeAll(InMemory, LockTable.layer())),
          ),
        ),
        Effect.scoped,
        Effect.exit,
      );
      expect(String(exit)).toContain("LockSearch reads LockList");
    }),
  );
});
