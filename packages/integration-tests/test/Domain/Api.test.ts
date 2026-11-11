import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

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
    Deposit: (account, { amount }) =>
      account.closed ? new AccountClosed() : [new Deposited({ amount })],
    Withdraw: (account, { amount }) =>
      account.closed
        ? new AccountClosed()
        : amount > account.balance
          ? new InsufficientFunds({ balance: account.balance, requested: amount })
          : [new Withdrawn({ amount })],
    Close: (account) => (account.closed ? [] : [new Closed()]),
  },
  evolve: {
    Deposited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ ...s, balance: s.balance - e.amount }),
    Closed: (s) => ({ ...s, closed: true }),
  },
}) {}

class Bank extends Domain.Model("Bank", { aggregates: [Account] }) {}

class BankApi extends Domain.Api("BankApi", {
  model: Bank,
  commands: ["Deposit", "Withdraw"],
}) {}
class CloseApi extends Domain.Api("CloseApi", {
  model: Bank,
  commands: ["Close"],
}) {}

/** A helper written once for every Api: the tags of its commands. */
const tagsOf = <A extends Domain.Api.Any>(api: A): ReadonlyArray<Domain.Api.CommandsOf<A>["tag"]> =>
  api.commands.map((command) => command.tag);

describe("Domain Api", { tags: ["unit", "local"] }, () => {
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
      const refused = yield* bank.Withdraw("a-1", { amount: 5 }).pipe(Effect.flip);
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

  it.effect("an Api serves everything of a kind it does not list", () =>
    Effect.sync(() => {
      class Everything extends Domain.Api("Everything", { model: Bank }) {}
      expect(Bank.commands).toEqual([Deposit, Withdraw, Close]);
      expect(Everything.commands).toEqual([Deposit, Withdraw, Close]);
      // An aggregate's state is never served: a view projects what clients see of it.
      expect(Everything.serves).toEqual([Deposit, Withdraw, Close]);
    }),
  );

  it.effect("an Api takes no aggregates to read", () =>
    Effect.sync(() => {
      // @ts-expect-error an Api serves commands, views, streams and queries; never an aggregate's state
      Domain.Api("AccountReads", { model: Bank, aggregates: ["Account"] });
    }),
  );

  it.effect("an Api serves none of a kind it lists as empty", () =>
    Effect.sync(() => {
      class Reads extends Domain.Api("Reads", { model: Bank, commands: [] }) {}
      expect(Reads.commands).toEqual([]);
      expect(Reads.serves).toEqual([]);
    }),
  );

  it.effect("naming something its model does not hold is a type error", () =>
    Effect.sync(() => {
      class Vaulted extends Domain.Model("Vaulted", { aggregates: [Vault] }) {}
      // @ts-expect-error Deposit is not a command of the Vaulted model
      const api = Domain.Api("Wrong", { model: Vaulted, commands: ["Deposit"] });
      expect(api.serves).toEqual([]);
      // @ts-expect-error Account is an aggregate, not a command
      Domain.Api("Mixed", { model: Bank, commands: ["Account"] });
    }),
  );

  it.live("naming something its model does not hold dies with a DefinitionError", () =>
    Effect.gen(function* () {
      // Typed as any model, so only serving it can tell.
      const model: Domain.Model.Any = Vaults;
      class LooseApi extends Domain.Api("LooseApi", { model, commands: ["Deposit"] }) {}
      const exit = yield* LooseApi.clientInProcess.pipe(Effect.scoped, Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "DefinitionError",
        message: "Deposit is not part of the Vaults model",
      });
    }).pipe(Effect.provide(Bank.layer(Layer.empty).pipe(Layer.provide(InMemory)))),
  );
});

// ---------------------------------------------------------------- rejections

/** A plain Effect tagged error, and a Domain shorthand with Effect's annotations. */
class Frozen extends Schema.TaggedError<Frozen>()("Frozen", { until: Schema.String }) {}
class NotOwner extends Domain.Rejection(
  "NotOwner",
  {},
  { httpApiStatus: 403, description: "Only the vault's owner may do this." },
) {}

class Stored extends Domain.Event("Stored", { item: Schema.String }) {}
class Store extends Domain.Command("Store", {
  target: Schema.String,
  input: { item: Schema.String },
  events: [Stored],
  // Any tagged error class can be a rejection, Effect's own HttpApiError included.
  rejects: [Frozen, NotOwner, HttpApiError.Forbidden],
}) {}
class Vault extends Domain.Aggregate("Vault", {
  id: Schema.String,
  state: Schema.Struct({ items: Schema.Array(Schema.String) }),
  initial: { items: [] },
  commands: [Store],
  decide: {
    Store: (_, { item }) =>
      item === "ice"
        ? new Frozen({ until: "spring" })
        : item === "gold"
          ? new HttpApiError.Forbidden()
          : item === "keys"
            ? new NotOwner()
            : [new Stored({ item })],
  },
  evolve: { Stored: (s, e) => ({ items: [...s.items, e.item] }) },
}) {}
class Vaults extends Domain.Model("Vaults", { aggregates: [Vault] }) {}
class VaultApi extends Domain.Api("VaultApi", { model: Vaults, commands: ["Store"] }) {}

describe("Domain Rejection", { tags: ["unit", "local"] }, () => {
  it.live("a command rejects with any tagged error class, and the client gets it typed", () =>
    Effect.gen(function* () {
      const vaults = yield* VaultApi.clientInProcess;
      const frozen = yield* vaults.Store("v-1", { item: "ice" }).pipe(Effect.flip);
      expect(frozen).toBeInstanceOf(Frozen);
      expect(frozen).toMatchObject({ until: "spring" });
      const forbidden = yield* vaults.Store("v-1", { item: "gold" }).pipe(Effect.flip);
      expect(forbidden).toBeInstanceOf(HttpApiError.Forbidden);
      expect((yield* vaults.Store("v-1", { item: "keys" }).pipe(Effect.flip))._tag).toBe(
        "NotOwner",
      );
      const { reply } = yield* vaults.Store("v-1", { item: "coat" });
      expect(reply).toBeUndefined();
      // The Api's rejections decode every one of them.
      expect(Schema.decodeUnknownSync(VaultApi.rejections)({ _tag: "Forbidden" })).toBeInstanceOf(
        HttpApiError.Forbidden,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Vaults.layer(Layer.empty).pipe(Layer.provideMerge(InMemory))),
    ),
  );

  it.effect(
    "a Domain.Rejection takes Schema.TaggedError's annotations, read as Effect reads them",
    () =>
      Effect.sync(() => {
        // An Effect HttpApi endpoint that declares the rejection gives it its status and description.
        const api = HttpApi.make("Vaults").add(
          HttpApiGroup.make("vaults").add(
            HttpApiEndpoint.post("store", "/store", { error: [NotOwner, Frozen] }),
          ),
        );
        const responses = OpenApi.fromApi(api).paths["/store"]!.post!.responses;
        expect(Object.keys(responses).sort()).toEqual(["204", "403", "500"]);
        expect(responses["403"]!.description).toBe("Only the vault's owner may do this.");
      }),
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
}) {}
/** What a client reads of a note: only its author may. */
class NoteView extends Domain.View("NoteView", {
  from: [Note],
  key: Note,
  middleware: [AuthorSession],
  rejects: [NotYours],
  state: Schema.Struct({ text: Schema.String, by: Schema.NullOr(Schema.String) }),
  initial: { text: "", by: null },
  evolve: { Written: (_, e) => ({ text: e.text, by: e.by }) },
}) {}

/** Who may read each key of NoteView. */
const NoteViewLive = NoteView.toLayer(
  Effect.succeed(
    Effect.fn(function* (_request, s) {
      if (s !== null && s.by !== null && s.by !== (yield* Author)) return yield* new NotYours();
    }),
  ),
);

class Notes extends Domain.Model("Notes", { aggregates: [Note], views: [NoteView] }) {}
class NotesApi extends Domain.Api("NotesApi", {
  model: Notes,
  commands: ["Write"],
  views: ["NoteView"],
}) {}

const World = Notes.layer(NoteViewLive).pipe(Layer.provideMerge(InMemory));

describe("Domain Api in process", { tags: ["unit", "local"] }, () => {
  it.live("clientInProcess calls an Api in process, through every entry's middleware", () =>
    Effect.gen(function* () {
      const notes = yield* NotesApi.clientInProcess;
      const asSam = { headers: { "x-author": "sam" } };

      const refused = yield* notes.Write("n-1", { text: "hi" }).pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthenticated");

      const receipt = yield* notes.Write("n-1", { text: "hi" }, asSam);
      expect(receipt.reply).toEqual({ by: "sam" });
      expect(yield* notes.NoteView.get("n-1", { ...asSam, atLeast: receipt })).toEqual({
        text: "hi",
        by: "sam",
      });

      const notYours = yield* notes.NoteView.get("n-1", {
        headers: { "x-author": "kim" },
        atLeast: receipt,
      }).pipe(Effect.flip);
      expect(notYours._tag).toBe("NotYours");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(World, AuthorSessionLive))),
  );

  it.live("a trusted caller provides its principal with its own middleware Layer", () =>
    Effect.gen(function* () {
      // The served Api keeps checking headers; only this client trusts its caller.
      const asKim = yield* NotesApi.clientInProcess.pipe(Effect.provide(trustedAuthor("kim")));
      const { reply } = yield* asKim.Write("n-2", { text: "from a webhook" });
      expect(reply).toEqual({ by: "kim" });

      const anonymous = yield* NotesApi.clientInProcess;
      const refused = yield* anonymous.NoteView.get("n-2").pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthenticated");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(World, AuthorSessionLive))),
  );

  it.live("layerClientInProcess provides the Api's Client in process", () => {
    // Written against `NotesApi.Client`, so it runs remotely (layerClient) or in process (layerClientInProcess).
    const writeAs = Effect.fn(function* (author: string) {
      const notes = yield* NotesApi.Client;
      return yield* notes.Write(
        "n-3",
        { text: "shared code" },
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
      const receipt = yield* notes.Write("n-4", { text: "over a protocol" }, asSam);
      expect(receipt.reply).toEqual({ by: "sam" });
      expect(yield* notes.NoteView.get("n-4", { ...asSam, atLeast: receipt })).toEqual({
        text: "over a protocol",
        by: "sam",
      });
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

// ---------------------------------------------------------------- a view's Layer

/** Authors an editor has suspended: kept outside the model. */
class Suspended extends Context.Service<Suspended, ReadonlySet<string>>()("Test/Suspended") {}

/** A note's text: anyone with a session reads it, unless its author is suspended. */
class NoteText extends Domain.View("NoteText", {
  from: [Note],
  key: Note,
  middleware: [AuthorSession],
  rejects: [NotYours],
  state: Schema.Struct({ text: Schema.String, by: Schema.NullOr(Schema.String) }),
  initial: { text: "", by: null },
  evolve: { Written: (_, e) => ({ text: e.text, by: e.by }) },
}) {}
// The Layer resolves what `validate` reads once; `validate` itself needs only the session.
const NoteTextLive = NoteText.toLayer(
  Effect.gen(function* () {
    const suspended = yield* Suspended;
    return Effect.fn(function* (_request, s) {
      yield* Author;
      if (s?.by && suspended.has(s.by)) return yield* new NotYours();
    });
  }),
);
class Texts extends Domain.Model("Texts", { aggregates: [Note], views: [NoteText] }) {}
class TextsApi extends Domain.Api("TextsApi", {
  model: Texts,
  commands: ["Write"],
  views: ["NoteText"],
}) {}
const TextsWorld = Layer.mergeAll(
  Texts.layer(NoteTextLive).pipe(Layer.provide(Layer.succeed(Suspended, new Set(["kim"])))),
  AuthorSessionLive,
).pipe(Layer.provideMerge(InMemory));

describe("Domain View validate on its Layer", { tags: ["unit", "local"] }, () => {
  it.live("validate reads a service its Layer resolved, traced as Domain.validate", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const texts = yield* TextsApi.clientInProcess;
      const asSam = { headers: { "x-author": "sam" } };
      const asKim = { headers: { "x-author": "kim" } };
      const fromSam = yield* texts.Write("t-1", { text: "hi" }, asSam);
      const fromKim = yield* texts.Write("t-2", { text: "spam" }, asKim);

      expect(
        yield* texts.NoteText.get("t-1", { ...asKim, atLeast: fromSam }).pipe(
          Effect.withTracer(tracer),
        ),
      ).toEqual({ text: "hi", by: "sam" });
      const suspended = yield* texts.NoteText.get("t-2", { ...asSam, atLeast: fromKim }).pipe(
        Effect.flip,
      );
      expect(suspended._tag).toBe("NotYours");

      const [validated] = spans.filter((span) => span.name === "Domain.validate NoteText");
      expect(validated!.attributes.get("domain.mode")).toBe("get");
    }).pipe(Effect.scoped, Effect.provide(TextsWorld)),
  );

  it.live(
    "a view that guards its reads needs its Layer: a type error, then a DefinitionError",
    () =>
      Effect.gen(function* () {
        // @ts-expect-error NoteText declares middleware and rejects, so the model needs NoteText's Layer
        Texts.layer(Layer.empty);
        const exit = yield* Layer.build(Texts.layer(Layer.empty as never)).pipe(
          Effect.provide(InMemory),
          Effect.exit,
        );
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
          _tag: "DefinitionError",
          reason: { _tag: "UnvalidatedRead", entity: "NoteText" },
        });
      }).pipe(Effect.scoped),
  );
});
