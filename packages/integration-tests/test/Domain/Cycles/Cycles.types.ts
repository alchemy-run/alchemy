/**
 * What the types of a cycle broken with thunks are. Type-checked only: each
 * line that must not compile carries `@ts-expect-error`, and each that must
 * holds an assignment to the type it should infer.
 */
import type * as AI from "@alchemy.run/ai";
import * as Domain from "@alchemy.run/domain";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Desk as EagerDesk } from "./fixtures/eager/Desk.model.ts";
import { Desk } from "./fixtures/lazy/Desk.model.ts";
import { Helper, HelperLive } from "./fixtures/lazy/Helper.process.ts";
import { Author, AuthorLive } from "./fixtures/mutual-lazy/Author.process.ts";
import { Reviewer } from "./fixtures/mutual-lazy/Reviewer.process.ts";
import { Ticket } from "./fixtures/shared/Ticket.aggregate.ts";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_: T) => _;

// ---------------------------------------------------------------- a model given as a thunk

// Its members are what the thunk returns, as if listed directly.
assert<Equals<(typeof Desk)["modelName"], "Desk">>(true);
assert<Equals<(typeof Desk)["views"][number]["viewName"], "TicketDetail">>(true);
// What a process mentions of it is there too.
Desk.CloseTicket;
Desk.TicketDetail;
// @ts-expect-error a model mentions only its own members
Desk.Workloads;

// The lazy and the eager model have the same type, but for their name's file.
assert<
  Equals<
    (typeof Desk)["views"][number]["viewName"],
    (typeof EagerDesk)["views"][number]["viewName"]
  >
>(true);

// ---------------------------------------------------------------- a view given as a thunk

// Its handlers are typed from what the thunk's `from` lists.
export class Opened extends Domain.View("Opened", () => ({
  from: [Ticket],
  key: Schema.String,
  keyOf: { TicketOpened: () => "all" },
  state: Schema.Struct({ subjects: Schema.Array(Schema.String) }),
  initial: { subjects: [] },
  evolve: {
    TicketOpened: (state, event) => ({ subjects: [...state.subjects, event.subject] }),
  },
})) {}
assert<Equals<Domain.View.StateOf<typeof Opened>, { readonly subjects: ReadonlyArray<string> }>>(
  true,
);

// A view takes aggregates and views: an AI process is not a source.
// @ts-expect-error a process is not something a view reads from
export class Follows extends Domain.View("Follows", () => ({
  from: [Helper],
  key: Schema.String,
  state: Schema.Struct({ n: Schema.Number }),
  initial: { n: 0 },
  evolve: {},
})) {}

// A mistake inside the thunk is reported on the thunk, not on the line it is on.
// @ts-expect-error `subject` is a string
export class Wrong extends Domain.View("Wrong", () => ({
  from: [Ticket],
  key: Ticket,
  state: Schema.Struct({ n: Schema.Number }),
  initial: { n: 0 },
  evolve: { TicketOpened: (_, event) => ({ n: event.subject }) },
})) {}

// ---------------------------------------------------------------- the prose's thunks

// A mention written as a thunk requires what the mention would: the model's clients.
type HelperNeeds = Layer.Services<typeof HelperLive>;
type DeskGives = Layer.Success<ReturnType<typeof Desk.layer>>;
// It requires what the model provides: the thunk's mention reached the model's type.
assert<Equals<Equals<Extract<HelperNeeds, DeskGives>, never>, false>>(true);
assert<Equals<Extract<HelperNeeds, AI.Harness>, AI.Harness>>(true);

// Two processes that mention each other through thunks need each other's client.
type AuthorNeeds = Layer.Services<typeof AuthorLive>;
assert<Equals<Extract<AuthorNeeds, (typeof Reviewer)["~process"]>, (typeof Reviewer)["~process"]>>(
  true,
);
void Author;

// ---------------------------------------------------------------- an Api over a lazy model

export class DeskApi extends Domain.Api("DeskApi", {
  model: Desk,
  views: ["TicketDetail"],
}) {}
declare const client: Domain.Api.ClientOf<typeof DeskApi>;
client.TicketDetail.get("t-1");
// @ts-expect-error the model keeps no view of a process
client.Helper.watch("t-1");

// ---------------------------------------------------------------- what a thunk cannot break

// Two processes whose prose is on their own classes, each mentioning the
// other, do not compile even with thunks: a class's type includes what its
// prose mentions, so each class's type would depend on the other's (TS2506,
// "referenced directly or indirectly in its own base expression"). A thunk
// defers the read, not the type. Declare such processes by name and give
// the prose in `toLayer`, as `fixtures/mutual-lazy` does: a Layer's type is
// not part of the class's.
