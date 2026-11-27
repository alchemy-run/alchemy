/**
 * Loads one fixture file first, in a fresh process, then builds what it
 * belongs to and checks that every mention resolved. Prints one JSON line:
 * `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`.
 *
 * bun load.ts <scenario> <entry file>
 */
import * as AI from "@alchemy.run/ai";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { recording } from "../../../AI/fixtures/recording.ts";

const [scenario, entry] = process.argv.slice(2);

class Smart extends AI.Model<Smart>()("smart") {}

/** A harness that runs nothing, on a model that is never called. */
const agents = () => {
  const harness = recording();
  const layer = Layer.mergeAll(harness.layer, AI.DefaultModel(Smart)).pipe(
    Layer.provideMerge(Smart.layer(Layer.succeed(LanguageModel.LanguageModel, undefined as never))),
  );
  return { harness, layer };
};

const desk = Effect.gen(function* () {
  const { Desk } = yield* Effect.promise(() => import(`./${scenario}/Desk.model.ts`));
  const { HelperLive, Helper } = yield* Effect.promise(
    () => import(`./${scenario}/Helper.process.ts`),
  );
  const { HandoverLive } = yield* Effect.promise(() => import(`./${scenario}/Handover.policy.ts`));
  const { Workload, ALL } = yield* Effect.promise(() => import(`./${scenario}/Workload.view.ts`));
  const { Ticket, OpenTicket } = yield* Effect.promise(
    () => import("./shared/Ticket.aggregate.ts"),
  );
  const { harness, layer } = agents();
  return yield* Effect.gen(function* () {
    const tickets = yield* Ticket;
    yield* tickets.send(new OpenTicket({ ticketId: "t-1", subject: "Stuck" }));
    const helper = yield* Helper;
    yield* helper.get("t-1").send("Close it.");
    // The view that follows the process is hosted and readable.
    const workload = yield* Workload;
    yield* workload.get(ALL);
    return { tools: harness.sessions.get("Helper/t-1")?.tools ?? [] };
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.sync(() => {
          // The desk needs a Helper, and the Helper's prose needs the desk.
          const DeskLive = Desk.layer(HandoverLive).pipe(Layer.provide(InMemory));
          const HelperHosted = AI.layerInMemory(
            HelperLive.pipe(Layer.provide(Layer.mergeAll(layer, DeskLive))),
          );
          return DeskLive.pipe(Layer.provideMerge(HelperHosted));
        }),
      ),
    ),
  );
});

const studio = Effect.gen(function* () {
  const { Author, AuthorLive } = yield* Effect.promise(
    () => import(`./${scenario}/Author.process.ts`),
  );
  const { ReviewerLive } = yield* Effect.promise(() => import(`./${scenario}/Reviewer.process.ts`));
  const { harness, layer } = agents();
  return yield* Effect.gen(function* () {
    const author = yield* Author;
    yield* author.get("draft-1").send("Write it.");
    return { tools: harness.sessions.get("Author/draft-1")?.tools ?? [] };
  }).pipe(
    // Each needs the other: hosted together, each is given the other's client.
    Effect.provide(
      AI.layerInMemory(Layer.mergeAll(AuthorLive, ReviewerLive).pipe(Layer.provide(layer))),
    ),
  );
});

const main = Effect.gen(function* () {
  yield* Effect.promise(() => import(`./${scenario}/${entry}`));
  return yield* scenario!.startsWith("mutual") ? studio : desk;
});

const exit = await Effect.runPromiseExit(
  main.pipe(Effect.scoped, Effect.provide(RuntimeContext.phantom)) as Effect.Effect<unknown>,
);
// The first line that names an error: what failed to load or resolve.
const failure = (cause: Cause.Cause<unknown>) =>
  Cause.pretty(cause)
    .split("\n")
    .find((line) => /Error/.test(line))
    ?.trim() ?? Cause.pretty(cause).split("\n")[0];
console.log(
  JSON.stringify(
    Exit.isSuccess(exit)
      ? { ok: true, ...(exit.value as object) }
      : { ok: false, error: failure(exit.cause) },
  ),
);
