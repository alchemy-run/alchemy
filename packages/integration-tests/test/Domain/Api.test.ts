import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

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

describe("Domain Api", () => {
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
