/**
 * SCENARIO — "have the engineer and the reviewer each look at this
 * independently and compare notes." The two looks FORK (they overlap;
 * neither sees the other's answer), and the JOIN reads both: when the
 * answers contradict each other, the manager is dispatched to
 * reconcile — when they agree, nobody else wakes up.
 *
 * Both branches of the join are asserted; the conflict judgment runs
 * LIVE against contradictory and agreeing scripted answers.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Agent } from "../../src/engineering/Burst.ts";
import { independentLooks } from "../../src/engineering/Looks.ts";

const query = ((questions, options) =>
  TS.query(questions, options).pipe(
    Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
  )) as typeof TypeSafe.SystemOne.Service;

const looksWorld = (script: Partial<Record<Agent, string>>) => {
  const posts: Array<{
    id: string;
    replyTo?: string;
    author: string;
    text: string;
  }> = [];
  const dispatches: Array<{ agent: Agent; start: number; end: number }> = [];
  let ids = 0;
  let now = 0;
  return {
    posts,
    dispatches,
    deps: {
      query,
      post: (input: { replyTo?: string; author?: string; text: string }) =>
        Effect.sync(() => {
          const id = `w-${++ids}`;
          posts.push({
            id,
            ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
            author: input.author ?? "swarm",
            text: input.text,
          });
          return id;
        }),
      dispatch: (agent: Agent, input: { thread: string; ask: string }) =>
        Effect.gen(function* () {
          const start = now++;
          yield* Effect.sleep("15 millis");
          const end = now++;
          dispatches.push({ agent, start, end });
          const answer = script[agent] ?? `${agent}: looks fine.`;
          posts.push({
            id: `w-${++ids}`,
            replyTo: input.thread,
            author: agent,
            text: answer,
          });
          return answer;
        }),
      budget: { maxDispatches: 6 },
    },
    overlapped: (a: Agent, b: Agent) => {
      const one = dispatches.find((entry) => entry.agent === a);
      const two = dispatches.find((entry) => entry.agent === b);
      return (
        one !== undefined &&
        two !== undefined &&
        one.start < two.end &&
        two.start < one.end
      );
    },
    dispatched: (agent: Agent) =>
      dispatches.some((entry) => entry.agent === agent),
  };
};

describe("swarm: fork-join", () => {
  test(
    "contradictory looks fork in parallel and the join wakes the manager",
    async () => {
      const world = looksWorld({
        engineer:
          "The retry loop is fine — the bug is in the pagination cursor, which resets on every retry.",
        reviewer:
          "The pagination is correct; the defect is the retry loop, it re-enters with a stale token.",
      });

      await Effect.runPromise(
        independentLooks(
          world.deps,
          "engineering",
          "Why does the log tail spin forever on UnsupportedOperation?",
          ["engineer", "reviewer"],
        ).pipe(Effect.provide(RuntimeContext.phantom)),
      );

      expect(world.overlapped("engineer", "reviewer")).toBe(true);
      expect(world.dispatched("manager")).toBe(true);
    },
    { timeout: 60_000 },
  );

  test(
    "agreeing looks need no reconciliation",
    async () => {
      const world = looksWorld({
        engineer:
          "The retry loop re-enters with a stale token — that's the defect.",
        reviewer:
          "Same read: stale token carried across retries; pagination itself is sound.",
      });

      await Effect.runPromise(
        independentLooks(
          world.deps,
          "engineering",
          "Why does the log tail spin forever on UnsupportedOperation?",
          ["engineer", "reviewer"],
        ).pipe(Effect.provide(RuntimeContext.phantom)),
      );

      expect(world.overlapped("engineer", "reviewer")).toBe(true);
      expect(world.dispatched("manager")).toBe(false);
    },
    { timeout: 60_000 },
  );
});
