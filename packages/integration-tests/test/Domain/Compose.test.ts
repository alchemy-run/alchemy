import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

// One shared aggregate, and two models (two bounded contexts) that react to it.
class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { owner: Schema.String },
  events: [Opened],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ owner: Schema.NullOr(Schema.String) }),
  initial: { owner: null },
  commands: [Open],
  decide: { Open: (_, { owner }) => [new Opened({ owner })] },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}

// Billing: a view and a policy that sends a command to its own aggregate.
class Invoiced extends Domain.Event("Invoiced") {}
class Invoice extends Domain.Command("Invoice", { target: Schema.String, events: [Invoiced] }) {}
class Billing extends Domain.Aggregate("Billing", {
  id: Schema.String,
  state: Schema.Struct({ invoiced: Schema.Boolean }),
  initial: { invoiced: false },
  commands: [Invoice],
  decide: { Invoice: () => [new Invoiced()] },
  evolve: { Invoiced: () => ({ invoiced: true }) },
}) {}
class Ledger extends Domain.View("Ledger", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ owner: Schema.String }),
  initial: { owner: "" },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}
class InvoiceOnOpen extends Domain.Policy("InvoiceOnOpen", { from: Account, on: [Opened] }) {}
const InvoiceOnOpenLive = InvoiceOnOpen.toLayer(
  Effect.gen(function* () {
    const billing = yield* Billing;
    return Effect.fn(function* ({ source }) {
      yield* billing.send(source.id, new Invoice());
    });
  }),
);
class BillingModel extends Domain.Model("BillingModel", {
  aggregates: [Account, Billing],
  views: [Ledger],
  policies: [InvoiceOnOpen],
}) {}

// Audit: another view and policy on the same aggregate.
class Noted extends Domain.Event("Noted", { what: Schema.String }) {}
class Note extends Domain.Command("Note", {
  target: Schema.String,
  input: { what: Schema.String },
  events: [Noted],
}) {}
class AuditLog extends Domain.Aggregate("AuditLog", {
  id: Schema.String,
  state: Schema.Struct({ notes: Schema.Array(Schema.String) }),
  initial: { notes: [] },
  commands: [Note],
  decide: { Note: (_, { what }) => [new Noted({ what })] },
  evolve: { Noted: (s, { what }) => ({ notes: [...s.notes, what] }) },
}) {}
class Owners extends Domain.View("Owners", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ owner: Schema.String }),
  initial: { owner: "" },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}
class AuditOnOpen extends Domain.Policy("AuditOnOpen", { from: Account, on: [Opened] }) {}
const AuditOnOpenLive = AuditOnOpen.toLayer(
  Effect.gen(function* () {
    const log = yield* AuditLog;
    return Effect.fn(function* ({ source, event }) {
      yield* log.send("audit", new Note({ what: `${source.id} opened by ${event.owner}` }));
    });
  }),
);
class AuditModel extends Domain.Model("AuditModel", {
  aggregates: [Account, AuditLog],
  views: [Owners],
  policies: [AuditOnOpen],
}) {}

/** Both contexts hosted as one: the shared aggregate is hosted once. */
class App extends Domain.Model("App", { models: [BillingModel, AuditModel] }) {}

const handlers = Layer.mergeAll(InvoiceOnOpenLive, AuditOnOpenLive);
const story = Story.make(App, { layer: handlers });
const a1 = Account.ref("a-1");

// The composed model's layer requires every composed model's handlers.
// @ts-expect-error AuditOnOpen has no implementation
export const missing = App.layer(InvoiceOnOpenLive);

/** A composed model may add members of its own. */
class BillingPlus extends Domain.Model("BillingPlus", {
  models: [BillingModel],
  views: [Owners],
}) {}

describe("Domain model composition", () => {
  it.effect("a shared aggregate's events reach every composed model", () =>
    story(
      Story.when(a1, new Open({ owner: "sam" })),
      Story.then(a1, new Opened({ owner: "sam" })),
      Story.view(Ledger, a1, { owner: "sam" }),
      Story.view(Owners, a1, { owner: "sam" }),
      Story.then(Billing.ref("a-1"), new Invoiced()),
      Story.then(AuditLog.ref("audit"), new Noted({ what: "a-1 opened by sam" })),
    ),
  );

  it.effect("a composed model's own members join the composed ones", () =>
    Story.make(BillingPlus, { layer: InvoiceOnOpenLive })(
      Story.when(a1, new Open({ owner: "sam" })),
      Story.view(Ledger, a1, { owner: "sam" }),
      Story.view(Owners, a1, { owner: "sam" }),
      Story.then(Billing.ref("a-1"), new Invoiced()),
    ),
  );

  it.live("one Api serves the views of every composed model", () =>
    Effect.gen(function* () {
      class AppApi extends Domain.Api("AppApi", Ledger, Owners) {}
      const client = yield* AppApi.testClient;
      const accounts = yield* Account;
      const receipt = yield* accounts.send("a-2", new Open({ owner: "alex" }));
      const atLeast = { stream: receipt.stream, version: receipt.version };
      expect(yield* client.Ledger.get("a-2", { atLeast })).toEqual({ owner: "alex" });
      expect(yield* client.Owners.get("a-2", { atLeast })).toEqual({ owner: "alex" });
    }).pipe(Effect.scoped, Effect.provide(App.layer(handlers).pipe(Layer.provide(InMemory)))),
  );

  it("hosting two models that share an aggregate side by side fails", () => {
    const exit = Effect.runSyncExit(
      Layer.build(
        Layer.mergeAll(BillingModel.layer(InvoiceOnOpenLive), AuditModel.layer(AuditOnOpenLive)),
      ).pipe(Effect.scoped, Effect.provide(InMemory)) as Effect.Effect<unknown>,
    );
    expect(String(exit)).toContain(
      "Aggregate Account is hosted twice on one platform: compose the models that share it into one, with `models: [...]`",
    );
  });
});
