/**
 * THE ASSOCIATION GRAPH — edges judged at WRITE time so search can
 * WALK instead of scan. Three facts under test, before any wiring:
 *
 * - SQUASH: rapid same-author messages are one utterance. Code
 *   segments the obvious (author, gap, interleaving); judgment
 *   confirms only the ambiguous middle (a topic shift inside a burst).
 * - TWO TIERS: a judged reply keeps its `answers` EDGE from 0.5 —
 *   walkable, searchable — but REWIRES the thread only from 0.75.
 *   Yesterday's pile-on miss lost the association entirely because
 *   one bar decided both; never again.
 * - PROVENANCE: every edge knows how it was made (structural edges
 *   from the DAG, judged edges from verdicts, authored edges from
 *   explicit references) and at what confidence, so a wrong judgment
 *   can be superseded without touching the DAG.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { describe, expect, test } from "bun:test";
import {
  EDGE_AT,
  REWIRE_AT,
  edgesOfJudgment,
  sameUtteranceQuestion,
  utterancesOf,
} from "../src/chat/Edges.ts";
import type { Line } from "../src/chat/Gate.ts";

const at = (
  id: string,
  author: string,
  text: string,
  ms: number,
): Line & {
  at: number;
} => ({ id, author, text, status: "settled", at: ms });

const SEC = 1_000;

describe("squash: segmentation is code", () => {
  test("a rapid same-author burst is one utterance", () => {
    const lines = [
      at("a1", "sam", "hey manager", 0),
      at("a2", "sam", "start me a thread on something", 8 * SEC),
      at("a3", "sam", "i mean without a thread", 20 * SEC),
    ];
    const utterances = utterancesOf(lines);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.posts.map((post) => post.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(utterances[0]!.text).toBe(
      "hey manager\nstart me a thread on something\ni mean without a thread",
    );
  });

  test("an interleaving speaker breaks the burst", () => {
    const utterances = utterancesOf([
      at("b1", "sam", "the deploy is failing", 0),
      at("b2", "manager", "Looking.", 5 * SEC),
      at("b3", "sam", "thanks", 10 * SEC),
    ]);
    expect(utterances.map((u) => u.posts.length)).toEqual([1, 1, 1]);
  });

  test("a long silence breaks the burst", () => {
    const utterances = utterancesOf([
      at("c1", "sam", "morning", 0),
      at("c2", "sam", "unrelated: the OOM is back", 10 * 60 * SEC),
    ]);
    expect(utterances).toHaveLength(2);
  });

  test("replies never squash into stream posts", () => {
    const utterances = utterancesOf([
      at("d1", "sam", "root message", 0),
      { ...at("d2", "sam", "reply elsewhere", 5 * SEC), replyTo: "x9" },
    ]);
    expect(utterances).toHaveLength(2);
  });
});

describe("squash: only ambiguity is judged", () => {
  const confirm = (previous: string, message: string) =>
    Effect.runPromise(
      TS.query(
        { sameUtterance: sameUtteranceQuestion },
        { state: { previous, message } },
      ).pipe(
        Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
        Effect.map((verdict) => verdict.value.sameUtterance),
      ),
    );

  test("a continuation confirms", async () => {
    expect(
      await confirm(
        "start me a thread on something",
        "i mean without a thread",
      ),
    ).toBe(true);
  });

  test("a topic shift inside a burst splits", async () => {
    expect(
      await confirm(
        "start me a thread on something",
        "unrelated — what port is the dev server on?",
      ),
    ).toBe(false);
  });
});

describe("two tiers: the edge survives below the rewire bar", () => {
  test("a mid-confidence reply keeps its edge and does NOT rewire", () => {
    const outcome = edgesOfJudgment({
      from: "p-new",
      repliesTo: "p-bug",
      confidence: 0.62,
      evidence: [],
    });
    expect(outcome.edges).toEqual([
      {
        from: "p-new",
        to: "p-bug",
        label: "answers",
        confidence: 0.62,
        provenance: "judged",
      },
    ]);
    expect(outcome.rewireTo).toBeUndefined();
  });

  test("a confident reply gets the edge AND the rewire", () => {
    const outcome = edgesOfJudgment({
      from: "p-new",
      repliesTo: "p-bug",
      confidence: 0.81,
      evidence: [],
    });
    expect(outcome.edges).toHaveLength(1);
    expect(outcome.rewireTo).toBe("p-bug");
  });

  test("below the edge bar nothing persists", () => {
    const outcome = edgesOfJudgment({
      from: "p-new",
      repliesTo: "p-bug",
      confidence: 0.4,
      evidence: [],
    });
    expect(outcome.edges).toEqual([]);
    expect(outcome.rewireTo).toBeUndefined();
  });

  test("scout evidence persists as `about` edges", () => {
    const outcome = edgesOfJudgment({
      from: "p-new",
      repliesTo: "none",
      confidence: 0.9,
      evidence: [{ ref: "#p-oom-1" }, { ref: "org/alchemy#1651" }],
    });
    expect(outcome.edges).toEqual([
      {
        from: "p-new",
        to: "#p-oom-1",
        label: "about",
        confidence: 1,
        provenance: "judged",
      },
      {
        from: "p-new",
        to: "org/alchemy#1651",
        label: "about",
        confidence: 1,
        provenance: "judged",
      },
    ]);
    expect(outcome.rewireTo).toBeUndefined();
  });

  test("the bars are where the doctrine says", () => {
    expect(EDGE_AT).toBe(0.5);
    expect(REWIRE_AT).toBe(0.75);
  });
});
