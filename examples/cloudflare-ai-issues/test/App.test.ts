import * as Domain from "@alchemy.run/domain";
import { expect, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Board } from "../src/Board/Board.model.ts";
import { BoardHandlers } from "../src/Board/Handlers.ts";
import { Issue } from "../src/Board/Issue.aggregate.ts";
import type { IssueId } from "../src/Board/Issue.id.ts";
import { IssueSession } from "../src/Board/IssueSession.aggregate.ts";
import { LabelIssue } from "../src/Board/LabelIssue.command.ts";
import { RecordActivity } from "../src/Board/RecordActivity.command.ts";
import { Triager } from "../src/Board/Triager.external.ts";
import { WebApi } from "../src/Board/WebApi.api.ts";
import { Message } from "../web/src/Board.ts";
import { open } from "./App.ts";

/**
 * Stands in for the issue's Durable Object and its agent: what the board
 * asks of the triager is played as a session that reads the message, labels
 * the issue and reports each step, the way `src/Agents.ts` records one.
 */
const agent: { play: (issue: IssueId, text: string) => Effect.Effect<void> } = {
  play: () => Effect.void,
};

const Hosted = Board.layer(BoardHandlers).pipe(
  Layer.provideMerge(
    Triager.toLayer(
      Effect.succeed({
        start: ({ issue }) => Effect.suspend(() => agent.play(issue, `The issue is ${issue}.`)),
        tell: ({ issue, text }) => Effect.suspend(() => agent.play(issue, text)),
      }),
    ),
  ),
  Layer.provideMerge(Domain.InMemory),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

/** The page's client, with the board in this process instead of over a network. */
const Live = WebApi.layerClientInProcess.pipe(Layer.provideMerge(Hosted));

const playing = Effect.gen(function* () {
  const sessions = yield* IssueSession;
  const issues = yield* Issue;
  const seqs = new Map<string, number>();
  agent.play = (issue, text) =>
    Effect.gen(function* () {
      const seq = seqs.get(issue) ?? 0;
      seqs.set(issue, seq + 2);
      const record = (status: "idle" | "working", items: RecordActivity["items"]) =>
        sessions.send(new RecordActivity({ issueId: issue, status, queued: [], items }));
      yield* record("working", [{ seq: seq + 1, item: { type: "user", text } }]);
      const label = text.includes("question") ? "question" : "bug";
      yield* issues.send(new LabelIssue({ issueId: issue, label }));
      yield* record("idle", [
        { seq: seq + 2, item: { type: "assistant", text: `Labeled ${label}.`, toolCalls: [] } },
      ]);
    }).pipe(Effect.orDie, Effect.forkDetach, Effect.asVoid);
});

const report = (page: Effect.Success<ReturnType<typeof open>>, title: string) =>
  Effect.gen(function* () {
    yield* page.dispatch(Message.ClickedNewIssue());
    yield* page.dispatch(Message.ChangedTitle({ text: title }));
    yield* page.dispatch(Message.SubmittedIssue());
    return yield* page.until(
      (model) => model.items.length === 2 && model.status === "idle" && model.caughtUp,
    );
  });

it.live("the page reports an issue and follows its agent to the end", () =>
  Effect.gen(function* () {
    yield* playing;
    const page = yield* open({ issueId: Option.none(), page: "a" });
    const empty = yield* page.until((model) => model.listed);
    expect(empty.issues).toEqual([]);

    const done = yield* report(page, "Export does nothing");
    expect(Option.map(done.detail, (detail) => detail.title)).toEqual(
      Option.some("Export does nothing"),
    );
    expect(done.items.map((entry) => entry.item)).toEqual([
      { type: "user", text: `The issue is ${Option.getOrThrow(done.selected)}.` },
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
    yield* playing;
    const page = yield* open({ issueId: Option.none(), page: "b" });
    yield* report(page, "Dark mode");

    yield* page.dispatch(Message.ChangedReply({ text: "It is only a question." }));
    yield* page.dispatch(Message.SubmittedReply());

    const done = yield* page.until(
      (model) =>
        model.items.length === 4 &&
        model.status === "idle" &&
        Option.exists(model.detail, (detail) => detail.label === "question"),
    );
    expect(done.items.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    const listed = yield* page.until((model) => model.issues[0]?.replies === 1);
    expect(listed.issues[0]).toMatchObject({ label: "question", replies: 1 });
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);

it.live("the board lists every issue, and clicking one opens its transcript", () =>
  Effect.gen(function* () {
    yield* playing;
    const page = yield* open({ issueId: Option.none(), page: "c" });
    const one = Option.getOrThrow((yield* report(page, "First")).selected);
    const two = Option.getOrThrow((yield* report(page, "Second")).selected);

    const both = yield* page.until((model) => model.issues.length === 2);
    // Newest first.
    expect(both.issues.map((issue) => issue.title)).toEqual(["Second", "First"]);

    yield* page.dispatch(Message.ClickedIssue({ issueId: one }));
    const opened = yield* page.until(
      (model) => model.items.length === 2 && Option.isSome(model.detail),
    );
    expect(opened.selected).toEqual(Option.some(one));
    expect(Option.map(opened.detail, (detail) => detail.title)).toEqual(Option.some("First"));
    expect(opened.items[0]?.item).toEqual({ type: "user", text: `The issue is ${one}.` });
    expect(two).not.toBe(one);
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);

it.live("a refreshed page resumes: it opens the issue its address names", () =>
  Effect.gen(function* () {
    yield* playing;
    const first = yield* open({ issueId: Option.none(), page: "d" });
    const issueId = Option.getOrThrow((yield* report(first, "Crash on save")).selected);

    // A new page load, with the issue in its address.
    const second = yield* open({ issueId: Option.some(issueId), page: "e" });
    const seen = yield* second.until(
      (model) => model.items.length === 2 && Option.isSome(model.detail) && model.listed,
    );
    expect(Option.map(seen.detail, (detail) => detail.title)).toEqual(Option.some("Crash on save"));
    expect(seen.items.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(seen.issues.map((issue) => issue.title)).toContain("Crash on save");
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);
