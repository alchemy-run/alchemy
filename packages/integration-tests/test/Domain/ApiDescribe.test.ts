import * as Domain from "@alchemy.run/domain";
import { Catalog } from "@alchemy.run/domain/ApiCatalog";
import { describe, expect, it } from "@alchemy.run/test";
import type * as JsonSchema from "effect/JsonSchema";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------- a wallet domain

const WalletId = Schema.String.pipe(Schema.brand("WalletId"));

class Owner extends Domain.RequestContext<Owner>()("Test/Owner", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Session extends RpcMiddleware.Service<Session, { provides: Owner }>()("Test/Session", {
  error: Unauthenticated,
}) {}

class Deposited extends Domain.Event("Deposited", { amount: Schema.Int, balance: Schema.Int }) {}
class OverLimit extends Domain.Rejection("OverLimit", { limit: Schema.Int }) {}
class NotOwner extends Domain.Rejection("NotOwner") {}

class Deposit extends Domain.Command("Deposit", {
  target: WalletId,
  input: { amount: Schema.Int },
  middleware: [Session],
  events: [Deposited],
  rejects: [OverLimit],
  reply: { balance: Schema.Int },
}) {}

class Wallet extends Domain.Aggregate("Wallet", {
  id: WalletId,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: {
    Deposit: (s, cmd) =>
      cmd.amount > 100
        ? new OverLimit({ limit: 100 })
        : [new Deposited({ amount: cmd.amount, balance: s.balance + cmd.amount })],
  },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  reply: { Deposit: (s) => ({ balance: s.balance }) },
  read: { middleware: [Session], rejects: [NotOwner] },
}) {}

class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  rejects: [NotOwner],
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
}) {}

class Receipt extends Domain.Event("Receipt", { amount: Schema.Int }) {}
class Receipts extends Domain.Stream("Receipts", { key: Wallet, entries: [Receipt] }) {}

class WalletApi extends Domain.Api("WalletApi", Deposit, Wallet, Balance, Receipts) {}

// ---------------------------------------------------------------- helpers

/** The `_tag`s a JSON Schema admits, through its `$defs`. */
const tagsOf = (schema: JsonSchema.JsonSchema): ReadonlyArray<string> => {
  const tags = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    const tag = (node as { properties?: { _tag?: { enum?: string[]; const?: string } } }).properties
      ?._tag;
    if (tag) for (const value of tag.enum ?? [tag.const!]) tags.add(value);
    Object.values(node).forEach(visit);
  };
  visit(schema);
  return [...tags].sort();
};

const operation = (catalog: Domain.Api.Catalog, rpc: string) => {
  const found = catalog.operations.find((op) => op.rpc === rpc);
  if (!found) throw new Error(`no operation ${rpc}`);
  return found;
};

// ---------------------------------------------------------------- tests

describe("Domain Api.describe", () => {
  it("lists every call the Api serves, in the order it declares its entries", () => {
    const catalog = Domain.Api.describe(WalletApi);
    expect(catalog.api).toBe("WalletApi");
    expect(
      catalog.operations.map((op) => [op.entry, op.kind, op.operation, op.mode, op.stream]),
    ).toEqual([
      ["Deposit", "Command", "send", "write", false],
      ["Wallet", "Aggregate", "get", "read", false],
      ["Wallet", "Aggregate", "watch", "read", true],
      ["Wallet", "Aggregate", "events", "read", true],
      ["Balance", "View", "get", "read", false],
      ["Balance", "View", "watch", "read", true],
      ["Balance", "View", "events", "read", true],
      ["Balance", "View", "list", "read", false],
      ["Balance", "View", "snapshot", "read", false],
      ["Receipts", "Stream", "peek", "read", false],
      ["Receipts", "Stream", "watch", "read", true],
      ["Receipts", "Stream", "events", "read", true],
      ["Receipts", "Stream", "list", "read", false],
    ]);
    expect(catalog.operations.every((op) => op.api === "WalletApi")).toBe(true);
    // One operation per RPC the server answers, and nothing else.
    expect(catalog.operations.map((op) => op.rpc)).toEqual([...WalletApi.group.requests.keys()]);
  });

  it("describes a command's wire input, its receipt and every typed failure", () => {
    const deposit = operation(Domain.Api.describe(WalletApi), "Deposit");
    expect(deposit.input).toMatchObject({
      type: "object",
      properties: {
        target: { type: "string" },
        commandId: {},
        input: { type: "object", properties: { amount: { type: "integer" } } },
      },
    });
    expect([...(deposit.input.required as string[])].sort()).toEqual(["input", "target"]);
    expect(deposit.success).toMatchObject({
      type: "object",
      properties: {
        reply: { type: "object", properties: { balance: {} } },
        stream: { type: "string" },
        version: {},
      },
    });
    // The declared rejection, and the error its middleware can fail with.
    expect(tagsOf(deposit.error)).toEqual(["OverLimit", "Unauthenticated"]);
  });

  it("describes a read's key, the value it returns, and its read rejections", () => {
    const catalog = Domain.Api.describe(WalletApi);
    const get = operation(catalog, "Balance.get");
    expect(Object.keys(get.input.properties as object).sort()).toEqual(["atLeast", "key", "where"]);
    expect(get.input.required).toEqual(["key"]);
    expect(JSON.stringify(get.success)).toContain('"balance"');
    expect(JSON.stringify(get.success)).toContain('"null"');
    // `atLeast` can also time out waiting for the caller's write.
    expect(tagsOf(get.error)).toEqual(["ConsistencyTimeout", "NotOwner"]);

    // A live read is described by what each element carries, not by the stream:
    // the state and the cursor it is valid at.
    const watch = operation(catalog, "Balance.watch");
    expect(watch.success).toMatchObject({
      type: "object",
      properties: { state: get.success, cursor: {} },
      required: ["state", "cursor"],
    });
    expect(tagsOf(watch.error)).toEqual(["NotOwner"]);

    // An aggregate read runs its contract's middleware too.
    expect(tagsOf(operation(catalog, "Wallet.get").error)).toEqual(["NotOwner", "Unauthenticated"]);
    // `events` sends its history, a `CaughtUp` frame, then live events.
    expect(tagsOf(operation(catalog, "Wallet.events").success)).toEqual(["CaughtUp", "Deposited"]);
    expect(tagsOf(operation(catalog, "Receipts.peek").success)).toEqual(["Receipt"]);
  });

  it("describes an entry with no rejections as one that cannot fail typed", () => {
    const watch = operation(Domain.Api.describe(WalletApi), "Receipts.watch");
    expect(watch.error).toEqual({ not: {} });
  });

  it("includes the errors of middleware applied to the whole Api", () => {
    class RateLimited extends Domain.Rejection("RateLimited") {}
    class RateLimit extends RpcMiddleware.Service<RateLimit>()("Test/RateLimit", {
      error: RateLimited,
    }) {}
    const catalog = Domain.Api.describe(WalletApi.middleware(RateLimit));
    expect(tagsOf(operation(catalog, "Deposit").error)).toEqual([
      "OverLimit",
      "RateLimited",
      "Unauthenticated",
    ]);
    expect(tagsOf(operation(catalog, "Receipts.watch").error)).toEqual(["RateLimited"]);
  });

  it("is plain JSON that decodes as a Catalog and is the same on every call", () => {
    const catalog = Domain.Api.describe(WalletApi);
    const json: unknown = JSON.parse(JSON.stringify(catalog));
    expect(json).toEqual(catalog);
    expect(Schema.decodeUnknownSync(Catalog)(json)).toEqual(catalog);
    expect(JSON.stringify(Domain.Api.describe(WalletApi))).toBe(JSON.stringify(catalog));
    // A second Api over the same entries gives the same catalog.
    class SameApi extends Domain.Api("WalletApi", Deposit, Wallet, Balance, Receipts) {}
    expect(JSON.stringify(Domain.Api.describe(SameApi))).toBe(JSON.stringify(catalog));
  });

  it("leaves out a description no entry declares", () => {
    const catalog = Domain.Api.describe(WalletApi);
    expect(catalog.operations.some((op) => "description" in op)).toBe(false);
  });
});
