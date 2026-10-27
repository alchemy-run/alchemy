import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Closed extends Domain.Event("Closed") {}

class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
  balance: Schema.Number,
  requested: Schema.Number,
}) {}
class AccountClosed extends Domain.Rejection("AccountClosed") {}

class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
  rejects: [AccountClosed],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
  rejects: [InsufficientFunds, AccountClosed],
}) {}
class Close extends Domain.Command("Close", { target: Schema.String, events: [Closed] }) {}

class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number, closed: Schema.Boolean }),
  initial: { balance: 0, closed: false },
  commands: [Deposit, Withdraw, Close],
  decide: {
    Deposit: (s, { amount }) => (s.closed ? new AccountClosed() : [new Deposited({ amount })]),
    Withdraw: (s, { amount }) =>
      s.closed
        ? new AccountClosed()
        : amount > s.balance
          ? new InsufficientFunds({ balance: s.balance, requested: amount })
          : [new Withdrawn({ amount })],
    Close: (s) => (s.closed ? [] : [new Closed()]),
  },
  evolve: {
    Deposited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ ...s, balance: s.balance - e.amount }),
    Closed: (s) => ({ ...s, closed: true }),
  },
  read: {},
}) {}

class Bank extends Domain.Model("Bank", { aggregates: [Account] }) {}

class BankApi extends Domain.Api("BankApi", Deposit, Account, Withdraw) {}
class CloseApi extends Domain.Api("CloseApi", Close, Account) {}

/** A helper written once for every Api: the tags of its commands. */
const tagsOf = <A extends Domain.Api.Any>(api: A): ReadonlyArray<Domain.Api.CommandsOf<A>["tag"]> =>
  api.commands.map((command) => command.tag);

describe("Domain Api", () => {
  it.effect("a concrete Api is an Api.Any", () =>
    Effect.sync(() => {
      const any: Domain.Api.Any = BankApi;
      const tags: ReadonlyArray<"Deposit" | "Withdraw"> = tagsOf(BankApi);
      expect(any.apiName).toBe("BankApi");
      expect(tags).toEqual(["Deposit", "Withdraw"]);
    }),
  );

  it.effect("commands are the command classes, in the order the Api lists them", () =>
    Effect.sync(() => {
      expect(BankApi.commands).toEqual([Deposit, Withdraw]);
      expect(CloseApi.commands).toEqual([Close]);
    }),
  );

  it.effect("rejections decodes every declared rejection to its class", () =>
    Effect.sync(() => {
      const Rejection = BankApi.rejections;
      const decoded = Schema.decodeUnknownSync(Rejection)({
        _tag: "InsufficientFunds",
        balance: 1,
        requested: 5,
      });
      const typed: InsufficientFunds | AccountClosed = decoded;
      // @ts-expect-error a union member is not one rejection
      const narrow: InsufficientFunds = decoded;
      expect(narrow).toBe(typed);
      expect(decoded).toBeInstanceOf(InsufficientFunds);
      expect(decoded).toMatchObject({ balance: 1, requested: 5 });
      expect(Schema.decodeUnknownSync(Rejection)({ _tag: "AccountClosed" })).toBeInstanceOf(
        AccountClosed,
      );
      // AccountClosed is declared by two commands, and is in the union once.
      expect((Rejection as unknown as Schema.Union<ReadonlyArray<Schema.Top>>).members).toEqual([
        AccountClosed,
        InsufficientFunds,
      ]);
      expect(() => Schema.decodeUnknownSync(Rejection)({ _tag: "Closed" })).toThrow();
    }),
  );

  it.effect("an Api whose commands never reject has Schema.Never rejections", () =>
    Effect.sync(() => {
      const Rejection: typeof Schema.Never = CloseApi.rejections;
      expect(Rejection).toBe(Schema.Never);
    }),
  );

  it.live("a rejection from the client is a member of the schema", () =>
    Effect.gen(function* () {
      const bank: Domain.Api.ClientOf<typeof BankApi> = yield* BankApi.Client;
      const isRejection = Schema.is(BankApi.rejections);
      const refused = yield* bank.Withdraw({ target: "a-1", amount: 5 }).pipe(Effect.flip);
      expect(isRejection(refused)).toBe(true);
      expect(refused).toBeInstanceOf(InsufficientFunds);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        BankApi.layerClientInProcess.pipe(
          Layer.provide(Bank.layer(Layer.empty).pipe(Layer.provide(InMemory))),
        ),
      ),
    ),
  );
});

// ---------------------------------------------------------------- calling in process

// ---------------------------------------------------------------- a notes domain

/** Who sent the request. The middleware provides it; `decide` and `validate` read it. */
class Author extends Domain.RequestContext<Author>()("Test/Author", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class NotYours extends Domain.Rejection("NotYours") {}

/** Authenticates every call from an `x-author` header. */
class AuthorSession extends RpcMiddleware.Service<AuthorSession, { provides: Author }>()(
  "Test/AuthorSession",
  { error: Unauthenticated },
) {}
const AuthorSessionLive = Layer.succeed(AuthorSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-author"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (name) => Effect.provideService(effect, Author, name),
  }),
);
/** Code that already knows who the caller is: provide it without checking a header. */
const trustedAuthor = (name: string) =>
  Layer.succeed(AuthorSession, (effect) => Effect.provideService(effect, Author, name));

class Written extends Domain.Event("Written", { text: Schema.String, by: Schema.String }) {}
class Write extends Domain.Command("Write", {
  target: Schema.String,
  middleware: [AuthorSession],
  input: { text: Schema.String },
  events: [Written],
  reply: { by: Schema.String },
}) {}
class Note extends Domain.Aggregate("Note", {
  id: Schema.String,
  state: Schema.Struct({ text: Schema.String, by: Schema.NullOr(Schema.String) }),
  initial: { text: "", by: null },
  commands: [Write],
  decide: {
    Write: Effect.fn(function* (_, cmd) {
      return [new Written({ text: cmd.text, by: yield* Author })];
    }),
  },
  evolve: { Written: (_, e) => ({ text: e.text, by: e.by }) },
  reply: { Write: (s) => ({ by: s.by ?? "" }) },
  read: {
    middleware: [AuthorSession],
    rejects: [NotYours],
    validate: Effect.fn(function* (_request, s) {
      if (s.by !== null && s.by !== (yield* Author)) return yield* new NotYours();
    }),
  },
}) {}

class Notes extends Domain.Model("Notes", { aggregates: [Note] }) {}
class NotesApi extends Domain.Api("NotesApi", Write, Note) {}

const World = Notes.layer(Layer.empty).pipe(Layer.provideMerge(InMemory));

describe("Domain Api in process", () => {
  it.live("clientInProcess calls an Api in process, through every entry's middleware", () =>
    Effect.gen(function* () {
      const notes = yield* NotesApi.clientInProcess;
      const asSam = { headers: { "x-author": "sam" } };

      const refused = yield* notes.Write({ target: "n-1", text: "hi" }).pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthenticated");

      const { reply } = yield* notes.Write({ target: "n-1", text: "hi" }, asSam);
      expect(reply).toEqual({ by: "sam" });
      expect(yield* notes.Note.get("n-1", asSam)).toEqual({ text: "hi", by: "sam" });

      const notYours = yield* notes.Note.get("n-1", { headers: { "x-author": "kim" } }).pipe(
        Effect.flip,
      );
      expect(notYours._tag).toBe("NotYours");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(World, AuthorSessionLive))),
  );

  it.live("a trusted caller provides its principal with its own middleware Layer", () =>
    Effect.gen(function* () {
      // The served Api keeps checking headers; only this client trusts its caller.
      const asKim = yield* NotesApi.clientInProcess.pipe(Effect.provide(trustedAuthor("kim")));
      const { reply } = yield* asKim.Write({ target: "n-2", text: "from a webhook" });
      expect(reply).toEqual({ by: "kim" });

      const anonymous = yield* NotesApi.clientInProcess;
      const refused = yield* anonymous.Note.get("n-2").pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthenticated");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(World, AuthorSessionLive))),
  );

  it.live("layerClientInProcess provides the Api's Client in process", () => {
    // Written against `NotesApi.Client`, so it runs remotely (layerClient) or in process (layerClientInProcess).
    const writeAs = Effect.fn(function* (author: string) {
      const notes = yield* NotesApi.Client;
      return yield* notes.Write(
        { target: "n-3", text: "shared code" },
        { headers: { "x-author": author } },
      );
    });
    return writeAs("sam").pipe(
      Effect.map(({ reply }) => expect(reply).toEqual({ by: "sam" })),
      Effect.provide(
        NotesApi.layerClientInProcess.pipe(
          Layer.provideMerge(Layer.mergeAll(World, AuthorSessionLive)),
        ),
      ),
    );
  });

  it.live("client runs over Domain.protocolInProcess", () =>
    Effect.gen(function* () {
      const notes = yield* NotesApi.client;
      const asSam = { headers: { "x-author": "sam" } };
      const { reply } = yield* notes.Write({ target: "n-4", text: "over a protocol" }, asSam);
      expect(reply).toEqual({ by: "sam" });
      expect(yield* notes.Note.get("n-4", asSam)).toEqual({ text: "over a protocol", by: "sam" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Domain.protocolInProcess(NotesApi).pipe(
          Layer.provideMerge(Layer.mergeAll(World, AuthorSessionLive)),
        ),
      ),
    ),
  );
});
