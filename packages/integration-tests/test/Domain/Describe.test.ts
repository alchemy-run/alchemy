import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Session extends RpcMiddleware.Service<Session>()("Test/Session", {
  error: Unauthenticated,
}) {}

class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
class Closed extends Domain.Event("Closed") {}
class Refused extends Domain.Rejection("Refused", { why: Schema.String }) {}

class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { owner: Schema.String },
  events: [Opened],
  rejects: [Domain.WrongPhase],
  reply: { owner: Schema.String },
  middleware: [Session],
}) {}
class Close extends Domain.Command("Close", {
  target: Schema.String,
  events: [Closed],
  rejects: [Domain.WrongPhase, Refused],
}) {}
const commands = [Open, Close] as const;

const makeAccount = (order: "open-first" | "close-first" = "open-first") =>
  class Account extends Domain.Aggregate("Account", {
    id: Schema.String,
    state: Schema.Struct({ phase: Schema.Literals(["new", "open", "closed"]) }),
    initial: { phase: "new" },
    commands:
      order === "open-first" ? commands : ([...commands].reverse() as unknown as typeof commands),
    decide: {
      Open: (_, cmd) => [new Opened({ owner: cmd.owner })],
      Close: () => [new Closed()],
    },
    evolve: {
      Opened: () => ({ phase: "open" as const }),
      Closed: () => ({ phase: "closed" as const }),
    },
    reply: { Open: (s) => ({ owner: s.phase }) },
    read: {},
    phases:
      order === "open-first"
        ? { new: { on: { Opened: "open" } }, open: { on: { Closed: "closed" } }, closed: {} }
        : { closed: {}, open: { on: { Closed: "closed" } }, new: { on: { Opened: "open" } } },
    phaseOf: (s) => s.phase,
    when: { Open: ["new"], Close: ["open"] },
  }) {};
const Account = makeAccount();

const Org = Schema.String.pipe(Schema.brand("Org"));
class Balance extends Domain.View("Balance", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  evolve: { Opened: () => ({ open: true }) },
}) {}
class ByOrg extends Domain.View("ByOrg", {
  from: [Account],
  key: Org,
  keyOf: { Opened: ({ event }) => Org.make(event.owner) },
  state: Schema.Struct({ count: Schema.Number }),
  initial: { count: 0 },
  evolve: { Opened: (s) => ({ count: s.count + 1 }) },
}) {}
class Card extends Domain.Event("Card", { owner: Schema.String }) {}
class Cards extends Domain.Stream("Cards", { key: Account, entries: [Card] }) {}
class WriteCards extends Domain.Projection("WriteCards", {
  from: [Account],
  key: Account,
  on: [Opened],
  writes: [Cards],
}) {}
class Greet extends Domain.Policy("Greet", { from: Account, on: [Opened] }) {}
class Move extends Domain.Saga("Move", {
  key: Schema.String,
  input: { amount: Schema.Number },
  result: { done: Schema.Boolean },
  rejects: [Refused],
}) {}

class Bank extends Domain.Model("Bank", {
  aggregates: [Account],
  views: [Balance, ByOrg],
  policies: [Greet],
  projections: [WriteCards],
  streams: [Cards],
  sagas: [Move],
}) {}
class BankApi extends Domain.Api("BankApi", Open, Balance, Account, Cards) {}

describe("Domain.describe", () => {
  const description = Domain.describe(Bank, { apis: [BankApi] });

  it("is plain JSON data", () => {
    expect(JSON.parse(JSON.stringify(description))).toEqual(description);
  });

  it("lists an aggregate's commands, events, rejections and phases", () => {
    const account = description.aggregates[0]!;
    expect(account.name).toBe("Account");
    expect(account.commands.map((command) => command.tag)).toEqual(["Close", "Open"]);
    expect(account.commands[1]).toMatchObject({
      tag: "Open",
      events: ["Opened"],
      rejects: ["WrongPhase"],
      middleware: ["Test/Session"],
      when: ["new"],
      reply: { schema: { type: "object" } },
    });
    expect(account.commands[0]).toMatchObject({ rejects: ["Refused", "WrongPhase"] });
    expect(account.events.map((event) => event.tag)).toEqual(["Closed", "Opened"]);
    expect(account.rejections.map((rejection) => rejection.tag)).toEqual(["Refused", "WrongPhase"]);
    expect(account.phases).toEqual({
      initial: "new",
      phases: [
        { name: "closed", on: [] },
        { name: "new", on: [{ event: "Opened", to: ["open"] }] },
        { name: "open", on: [{ event: "Closed", to: ["closed"] }] },
      ],
    });
  });

  it("gives each schema's JSON form", () => {
    const opened = description.aggregates[0]!.events[1]!;
    expect(JSON.stringify(opened.schema)).toContain('"owner"');
  });

  it("lists views, policies, projections, streams, sagas and apis", () => {
    expect(description.views).toMatchObject([
      { name: "Balance", from: ["Account"], key: { aggregate: "Account" } },
      { name: "ByOrg", from: ["Account"], key: { schema: { schema: { type: "string" } } } },
    ]);
    expect(description.policies).toEqual([{ name: "Greet", from: ["Account"], on: ["Opened"] }]);
    expect(description.projections).toEqual([
      {
        name: "WriteCards",
        from: ["Account"],
        key: { aggregate: "Account" },
        on: ["Opened"],
        writes: ["Cards"],
      },
    ]);
    expect(description.streams).toEqual([
      { name: "Cards", key: { aggregate: "Account" }, entries: ["Card"] },
    ]);
    expect(description.sagas).toMatchObject([{ name: "Move", rejects: ["Refused"] }]);
    expect(description.apis).toEqual([
      {
        name: "BankApi",
        entries: [
          { kind: "Aggregate", name: "Account" },
          { kind: "View", name: "Balance" },
          { kind: "Stream", name: "Cards" },
          { kind: "Command", name: "Open" },
        ],
      },
    ]);
  });

  it("leaves out what a model does not use", () => {
    class Plain extends Domain.Aggregate("Plain", {
      id: Schema.String,
      state: Schema.Struct({}),
      initial: {},
      commands: [],
      decide: {},
      evolve: {},
    }) {}
    class Small extends Domain.Model("Small", { aggregates: [Plain] }) {}
    const small = Domain.describe(Small);
    expect(small.aggregates[0]).not.toHaveProperty("phases");
    expect(small.views).toEqual([]);
    expect(small.apis).toEqual([]);
  });

  describe("hash", () => {
    const hashOf = (aggregate: Domain.Aggregate.Any) =>
      Domain.describe(class extends Domain.Model("M", { aggregates: [aggregate] }) {}).hash;

    it("is the same for the same model", () => {
      expect(Domain.describe(Bank, { apis: [BankApi] }).hash).toBe(description.hash);
      expect(description.hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("ignores the order of a declaration", () => {
      expect(hashOf(makeAccount("close-first"))).toBe(hashOf(makeAccount("open-first")));
    });

    it("pins one value, so a runtime can't drift", () => {
      class Pinned extends Domain.Aggregate("Pinned", {
        id: Schema.String,
        state: Schema.Struct({}),
        initial: {},
        commands: [],
        decide: {},
        evolve: {},
      }) {}
      expect(hashOf(Pinned)).toBe("59d5ef0dca30f651");
    });

    it("changes with a schema, a tag, a phase and an Api", () => {
      const base = hashOf(makeAccount());
      const withState = (state: Schema.Top) => {
        const account = Object.create(Account) as Domain.Aggregate.Any;
        Object.defineProperty(account, "definition", { value: { ...Account.definition, state } });
        return account;
      };
      expect(
        hashOf(
          withState(
            Schema.Struct({
              phase: Schema.Literals(["new", "open", "closed"]),
              extra: Schema.Number,
            }),
          ),
        ),
      ).not.toBe(base);
      const withTable = (table: object) => {
        const account = Object.create(Account) as Domain.Aggregate.Any;
        Object.defineProperty(account, "definition", {
          value: { ...Account.definition, ...table },
        });
        return account;
      };
      expect(hashOf(withTable({ when: { Open: ["new", "open"], Close: ["open"] } }))).not.toBe(
        base,
      );
      expect(
        hashOf(
          withTable({
            phases: { ...Account.definition.phases, archived: {} },
          }),
        ),
      ).not.toBe(base);
      expect(Domain.describe(Bank).hash).not.toBe(description.hash);
    });

    it("does not change with a handler, which is code", () => {
      const other = Object.create(Account) as Domain.Aggregate.Any;
      Object.defineProperty(other, "definition", {
        value: { ...Account.definition, decide: { ...Account.definition.decide, Close: () => [] } },
      });
      expect(hashOf(other)).toBe(hashOf(makeAccount()));
    });
  });
});
