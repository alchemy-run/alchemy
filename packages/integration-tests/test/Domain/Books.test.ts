import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

// Closing the books: an account's entries live in one instance per period. The model is the one
// the "Keeping history small" guide teaches.

const BookState = Schema.Struct({
  balance: Schema.Int,
  opened: Schema.Boolean,
  closed: Schema.Boolean,
});

class BookOpened extends Domain.Event("BookOpened", {
  broughtForward: Schema.Int,
  balanceAfter: Schema.Int,
}) {}
class Posted extends Domain.Event("Posted", { amount: Schema.Int, balanceAfter: Schema.Int }) {}
class BookClosed extends Domain.Event("BookClosed", {
  balance: Schema.Int,
  next: Schema.String,
}) {}
class BookArchived extends Domain.Event("BookArchived", { state: BookState }) {}

class BookIsClosed extends Domain.Rejection("BookIsClosed") {}

class OpenBook extends Domain.Command("OpenBook", {
  input: { bookId: Schema.String, broughtForward: Schema.Int },
  events: [BookOpened],
}) {}
class Post extends Domain.Command("Post", {
  input: { bookId: Schema.String, amount: Schema.Int },
  events: [Posted],
  rejects: [BookIsClosed],
}) {}
class CloseBook extends Domain.Command("CloseBook", {
  input: { bookId: Schema.String, next: Schema.String },
  events: [BookClosed],
}) {}

class Book extends Domain.Aggregate("Book", {
  id: Schema.String,
  state: BookState,
  initial: { balance: 0, opened: false, closed: false },
  commands: [OpenBook, Post, CloseBook],
  events: [BookArchived],
  keyOf: (command) => command.bookId,
  decide: {
    OpenBook: (book, { broughtForward }) =>
      book.opened
        ? []
        : [new BookOpened({ broughtForward, balanceAfter: book.balance + broughtForward })],
    Post: (book, { amount }) =>
      book.closed
        ? new BookIsClosed()
        : [new Posted({ amount, balanceAfter: book.balance + amount })],
    CloseBook: (book, { next }) =>
      book.closed ? [] : [new BookClosed({ balance: book.balance, next })],
  },
  evolve: {
    BookOpened: (book, e) => ({ ...book, opened: true, balance: e.balanceAfter }),
    Posted: (book, e) => ({ ...book, balance: e.balanceAfter }),
    BookClosed: (book) => ({ ...book, closed: true }),
    BookArchived: (_, e) => e.state,
  },
}) {}

class Statement extends Domain.View("Statement", {
  from: [Book],
  key: Book,
  state: Schema.Struct({ balance: Schema.Int, entries: Schema.Int, closed: Schema.Boolean }),
  initial: { balance: 0, entries: 0, closed: false },
  evolve: {
    BookOpened: (statement, e) => ({ ...statement, balance: e.balanceAfter }),
    Posted: (statement, e) => ({
      ...statement,
      balance: e.balanceAfter,
      entries: statement.entries + 1,
    }),
    BookClosed: (statement) => ({ ...statement, closed: true }),
    BookArchived: (statement, e) => ({
      ...statement,
      balance: e.state.balance,
      closed: e.state.closed,
    }),
  },
}) {}

class OpenNextBook extends Domain.Policy("OpenNextBook", { from: Book, on: [BookClosed] }) {}

const OpenNextBookLive = OpenNextBook.toLayer(
  Effect.gen(function* () {
    const books = yield* Book;
    return Effect.fn(function* ({ event }) {
      yield* books.send(new OpenBook({ bookId: event.next, broughtForward: event.balance }));
    });
  }),
);

class ArchiveBook extends Domain.Compaction("ArchiveBook", {
  of: Book,
  rollup: (book) => [new BookArchived({ state: book })],
}) {}

const ArchiveBookLive = ArchiveBook.toLayer(
  Effect.succeed(Effect.fn(function* (_batch: Domain.Compaction.Batch<typeof Book>) {})),
);

class ArchiveClosedBook extends Domain.Policy("ArchiveClosedBook", {
  from: Book,
  on: [BookClosed],
}) {}

const ArchiveClosedBookLive = ArchiveClosedBook.toLayer(
  Effect.gen(function* () {
    const books = yield* Book;
    return Effect.fn(function* ({ source }) {
      yield* books.compact(source, ArchiveBook).pipe(Effect.orDie);
    });
  }),
);

class DropBook extends Domain.Rewrite("DropBook", { of: Book, delete: true }) {}

class Books extends Domain.Model("Books", {
  aggregates: [Book],
  views: [Statement],
  policies: [OpenNextBook, ArchiveClosedBook],
  compactions: [ArchiveBook],
}) {}

/** The same books, kept whole until they are removed. */
class KeptBooks extends Domain.Model("KeptBooks", {
  aggregates: [Book],
  views: [Statement],
  policies: [OpenNextBook],
  rewrites: [DropBook],
}) {}

describe("Domain, a book per period", { tags: ["unit", "local"] }, () => {
  const january = Book.ref("a-1.2026-01");
  const february = Book.ref("a-1.2026-02");

  it.effect("closing a book opens the next one with its balance, and archives it", () =>
    Story.make(Books, {
      layer: Layer.mergeAll(OpenNextBookLive, ArchiveClosedBookLive, ArchiveBookLive),
    })(
      Story.given(
        january,
        new Posted({ amount: 500, balanceAfter: 500 }),
        new Posted({ amount: -120, balanceAfter: 380 }),
      ),
      Story.when(new CloseBook({ bookId: "a-1.2026-01", next: "a-1.2026-02" })),
      Story.then(february, new BookOpened({ broughtForward: 380, balanceAfter: 380 })),
      Story.state(january, { balance: 380, closed: true }),
      Story.view(Statement, january, { balance: 380, entries: 2, closed: true }),
      Story.when(new Post({ bookId: "a-1.2026-02", amount: 20 })),
      Story.then(february, new Posted({ amount: 20, balanceAfter: 400 })),
      Story.view(Statement, february, { balance: 400, entries: 1, closed: false }),
      Story.when(new Post({ bookId: "a-1.2026-01", amount: 1 })),
      Story.rejected(new BookIsClosed()),
    ),
  );

  it.effect("a closed book that is removed leaves the next one as it is", () =>
    Story.make(KeptBooks, { layer: OpenNextBookLive })(
      Story.given(january, new Posted({ amount: 500, balanceAfter: 500 })),
      Story.when(new CloseBook({ bookId: "a-1.2026-01", next: "a-1.2026-02" })),
      Story.then(january, new BookClosed({ balance: 500, next: "a-1.2026-02" })),
      Story.then(february, new BookOpened({ broughtForward: 500, balanceAfter: 500 })),
      Story.view(Statement, january, { balance: 500, entries: 1, closed: true }),
      Story.when(new Post({ bookId: "a-1.2026-01", amount: 1 })),
      Story.rejected(new BookIsClosed()),
      Story.rewrite(january, new DropBook()),
      Story.view(Statement, january, Story.none),
      Story.view(Statement, february, { balance: 500, entries: 0, closed: false }),
    ),
  );
});
