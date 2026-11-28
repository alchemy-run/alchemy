import * as AI from "@alchemy.run/ai";
import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Board } from "../src/Board/Board.model.ts";
import { Issue } from "../src/Board/Issue.aggregate.ts";
import { IssueId } from "../src/Board/Issue.id.ts";
import { IssueWorkLive } from "../src/Board/IssueWork.policy.ts";
import { LabelIssue } from "../src/Board/LabelIssue.command.ts";
import { started } from "../src/Board/Said.ts";
import { WebApi } from "../src/Board/WebApi.api.ts";
import { Triage } from "../src/Triage.process.ts";
import { listOf, Message, Sessions, threadOf } from "../web/src/Board.ts";
import { open } from "./App.ts";

/**
 * Triage, played by code in place of a model: a session reads its message,
 * labels the issue and answers. It is hosted as the real one is, and the
 * board records what it does the same way.
 */
const TriagePlayed = AI.scripted(
  Triage,
  Effect.gen(function* () {
    const issues = yield* Issue;
    return Effect.fn(function* ({ key, text }: AI.Turn) {
      const label = text.includes("question") ? "question" : "bug";
      yield* issues.send(new LabelIssue({ issueId: IssueId.make(key), label }));
      return `Labeled ${label}.`;
    }, Effect.orDie);
  }),
);

const BoardInMemory = Board.layer(IssueWorkLive).pipe(
  Layer.provideMerge(Domain.InMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

const TriageInMemory = AI.layerInMemory(TriagePlayed.pipe(Layer.provide(BoardInMemory)));

const Hosted = Layer.mergeAll(BoardInMemory, TriageInMemory).pipe(Layer.provide(TriageInMemory));

/** The page's read of a session, from the session itself instead of over a network. */
const SessionsInProcess = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const triage = yield* Triage;
    return {
      read: (issueId, after) =>
        Effect.gen(function* () {
          const session = triage.get(issueId);
          return { ...(yield* session.status), ...(yield* session.history({ after, take: 100 })) };
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    };
  }),
);

/** The page's client, with the board in this process instead of over a network. */
const Live = Layer.mergeAll(WebApi.layerClientInProcess, SessionsInProcess).pipe(
  Layer.provideMerge(Hosted),
);

const report = (page: Effect.Success<ReturnType<typeof open>>, title: string) =>
  Effect.gen(function* () {
    yield* page.dispatch(Message.ClickedNewIssue());
    yield* page.dispatch(Message.ChangedTitle({ text: title }));
    yield* page.dispatch(Message.SubmittedIssue());
    return yield* page.until(
      (model) =>
        threadOf(model).items.length === 2 &&
        threadOf(model).status === "idle" &&
        model.pending.length === 0,
    );
  });

it.live("the page reports an issue and follows its agent to the end", () =>
  Effect.gen(function* () {
    const page = yield* open({ issues: [], issueId: Option.none(), page: "a" });
    const empty = yield* page.until((model) => model.listed);
    expect(empty.issues).toEqual([]);

    // The moment it is submitted, before the board has answered, it is all on screen.
    yield* page.dispatch(Message.ChangedTitle({ text: "Export does nothing" }));
    yield* page.dispatch(Message.SubmittedIssue());
    const instant = yield* page.until(() => true);
    expect(Option.map(threadOf(instant).detail, (detail) => detail.title)).toEqual(
      Option.some("Export does nothing"),
    );
    expect(threadOf(instant).status).toBe("working");
    expect(listOf(instant).map((issue) => issue.title)).toEqual(["Export does nothing"]);

    const done = yield* page.until(
      (model) => threadOf(model).items.length === 2 && threadOf(model).status === "idle",
    );
    expect(Option.map(threadOf(done).detail, (detail) => detail.title)).toEqual(
      Option.some("Export does nothing"),
    );
    expect(threadOf(done).items.map((entry) => entry.item)).toEqual([
      { type: "user", text: started(Option.getOrThrow(done.selected)) },
      { type: "assistant", text: "Labeled bug.", toolCalls: [] },
    ]);
    expect(done.error).toEqual(Option.none());

    // The sidebar lists it, labeled, with its agent idle again.
    const listed = yield* page.until((model) => model.issues[0]?.label === "bug");
    expect(listed.issues).toEqual([
      {
        issueId: Option.getOrThrow(done.selected),
        title: "Export does nothing",
        label: "bug",
        replies: 0,
        working: false,
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);

it.live("a reply reaches the agent, and the page shows what it did with it", () =>
  Effect.gen(function* () {
    const page = yield* open({ issues: [], issueId: Option.none(), page: "b" });
    yield* report(page, "Dark mode");

    yield* page.dispatch(Message.ChangedReply({ text: "It is only a question." }));
    yield* page.dispatch(Message.SubmittedReply());

    const done = yield* page.until(
      (model) =>
        threadOf(model).items.length === 4 &&
        threadOf(model).status === "idle" &&
        Option.exists(threadOf(model).detail, (detail) => detail.label === "question"),
    );
    expect(threadOf(done).items.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    const listed = yield* page.until((model) => model.issues[0]?.replies === 1);
    expect(listed.issues[0]).toMatchObject({ label: "question", replies: 1 });
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);

it.live("the board lists every issue, and clicking one opens its transcript", () =>
  Effect.gen(function* () {
    const page = yield* open({ issues: [], issueId: Option.none(), page: "c" });
    const one = Option.getOrThrow((yield* report(page, "First")).selected);
    const two = Option.getOrThrow((yield* report(page, "Second")).selected);

    const both = yield* page.until((model) => model.issues.length === 2);
    // Newest first.
    expect(both.issues.map((issue) => issue.title)).toEqual(["Second", "First"]);

    yield* page.dispatch(Message.ClickedIssue({ issueId: one }));
    const opened = yield* page.until(
      (model) => threadOf(model).items.length === 2 && Option.isSome(threadOf(model).detail),
    );
    expect(opened.selected).toEqual(Option.some(one));
    expect(Option.map(threadOf(opened).detail, (detail) => detail.title)).toEqual(
      Option.some("First"),
    );
    expect(threadOf(opened).items[0]?.item).toEqual({ type: "user", text: `The issue is ${one}.` });
    expect(two).not.toBe(one);
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);

it.live("a refreshed page resumes: it opens the issue its address names", () =>
  Effect.gen(function* () {
    const first = yield* open({ issues: [], issueId: Option.none(), page: "d" });
    const issueId = Option.getOrThrow((yield* report(first, "Crash on save")).selected);

    // A new page load, with the issue in its address.
    const second = yield* open({ issues: [], issueId: Option.some(issueId), page: "e" });
    const seen = yield* second.until(
      (model) =>
        threadOf(model).items.length === 2 && Option.isSome(threadOf(model).detail) && model.listed,
    );
    expect(Option.map(threadOf(seen).detail, (detail) => detail.title)).toEqual(
      Option.some("Crash on save"),
    );
    expect(threadOf(seen).items.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(seen.issues.map((issue) => issue.title)).toContain("Crash on save");
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);
