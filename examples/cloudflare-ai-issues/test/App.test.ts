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
import { IssueId } from "../src/Board/Issue.id.ts";
import { IssueSession } from "../src/Board/IssueSession.aggregate.ts";
import { LabelIssue } from "../src/Board/LabelIssue.command.ts";
import { RecordActivity } from "../src/Board/RecordActivity.command.ts";
import { Triager } from "../src/Board/Triager.external.ts";
import { WebApi } from "../src/Board/WebApi.api.ts";
import { Message } from "../web/src/Issue.ts";
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

it.live("the page reports an issue and follows its agent to the end", () =>
  Effect.gen(function* () {
    yield* playing;
    const page = yield* open({ issueId: IssueId.make("42"), page: "p" });

    // Nothing is reported yet: the page shows an empty issue and an idle agent.
    const empty = yield* page.until((model) => Option.isSome(model.cursor));
    expect(empty.title).toEqual(Option.none());
    expect(empty.status).toBe("idle");
    expect(empty.items).toEqual([]);

    yield* page.dispatch(Message.ChangedDraft({ text: "Export does nothing" }));
    yield* page.dispatch(Message.ClickedReport());

    const done = yield* page.until(
      (model) => model.items.length === 2 && model.status === "idle" && Option.isSome(model.label),
    );
    expect(done.title).toEqual(Option.some("Export does nothing"));
    expect(done.label).toEqual(Option.some("bug"));
    expect(done.items.map((entry) => entry.item)).toEqual([
      { type: "user", text: "The issue is 42." },
      { type: "assistant", text: "Labeled bug.", toolCalls: [] },
    ]);
    expect(done.error).toEqual(Option.none());
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);

it.live("a reply reaches the agent, and the page shows what it did with it", () =>
  Effect.gen(function* () {
    yield* playing;
    const page = yield* open({ issueId: IssueId.make("43"), page: "p" });
    yield* page.dispatch(Message.ChangedDraft({ text: "Dark mode" }));
    yield* page.dispatch(Message.ClickedReport());
    yield* page.until((model) => model.items.length === 2 && model.status === "idle");

    yield* page.dispatch(Message.ChangedDraft({ text: "It is only a question." }));
    yield* page.dispatch(Message.ClickedReply());

    const done = yield* page.until(
      (model) =>
        model.items.length === 4 &&
        model.status === "idle" &&
        Option.contains(model.label, "question"),
    );
    expect(done.items.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(done.items.at(-1)?.item).toEqual({
      type: "assistant",
      text: "Labeled question.",
      toolCalls: [],
    });
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);

it.live("a page opened later reads the whole transcript", () =>
  Effect.gen(function* () {
    yield* playing;
    const first = yield* open({ issueId: IssueId.make("44"), page: "a" });
    yield* first.dispatch(Message.ChangedDraft({ text: "Crash on save" }));
    yield* first.dispatch(Message.ClickedReport());
    yield* first.until((model) => model.items.length === 2 && model.status === "idle");

    const second = yield* open({ issueId: IssueId.make("44"), page: "b" });
    const seen = yield* second.until(
      (model) => model.items.length === 2 && Option.isSome(model.label),
    );
    expect(seen.title).toEqual(Option.some("Crash on save"));
    expect(seen.items.map((entry) => entry.seq)).toEqual([1, 2]);
  }).pipe(Effect.scoped, Effect.provide(Live), Effect.provide(RuntimeContext.phantom)),
);
