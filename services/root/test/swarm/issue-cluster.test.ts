/**
 * SCENARIO — six issues arrive in an hour, near-duplicates of two
 * underlying root causes, with no buckets known up front. A good team
 * notices the duplication, opens ONE thread, and works each ROOT
 * CAUSE as its own sub-thread (engineer dispatched per cluster) —
 * six issues, two pieces of work, not six.
 *
 * Emergent grouping: the walker seeds a cluster from the first item
 * and asks, per item, "which existing cluster, or new?" — Scout's
 * wide-Choice trick pointed at intake. Judgments run LIVE.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Agent, InboundEvent } from "../../src/engineering/Burst.ts";
import { handleCluster } from "../../src/engineering/Cluster.ts";

const query = ((questions, options) =>
  TS.query(questions, options).pipe(
    Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
  )) as typeof TypeSafe.SystemOne.Service;

const clusterWorld = () => {
  const posts: Array<{
    id: string;
    replyTo?: string;
    author: string;
    text: string;
  }> = [];
  const dispatches: Array<{ agent: Agent; ask: string }> = [];
  let ids = 0;
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
            author: input.author ?? "manager",
            text: input.text,
          });
          return id;
        }),
      dispatch: (agent: Agent, input: { thread: string; ask: string }) =>
        Effect.sync(() => {
          dispatches.push({ agent, ask: input.ask });
          posts.push({
            id: `w-${++ids}`,
            replyTo: input.thread,
            author: agent,
            text: `${agent}: on it.`,
          });
          return `${agent}: on it.`;
        }),
      budget: { maxDispatches: 12 },
    },
    childrenOf: (id: string | undefined) =>
      posts.filter((post) => post.replyTo === id),
  };
};

describe("swarm: issue cluster", () => {
  test(
    "six near-duplicate issues become one thread with a sub-thread per root cause",
    async () => {
      const world = clusterWorld();
      const events: InboundEvent[] = [
        // root cause A: the dev worker OOM on big pack imports
        {
          repo: "org/alchemy",
          number: 3001,
          kind: "issue",
          title: "dev worker crashes with OOM importing distilled",
        },
        {
          repo: "org/alchemy",
          number: 3002,
          kind: "issue",
          title: "[BUG] out of memory during git import of large repo",
        },
        {
          repo: "org/alchemy",
          number: 3003,
          kind: "issue",
          title: "alchemy dev eats 8GB then dies when seeding mirrors",
        },
        // root cause B: D1 migration BEGIN casing
        {
          repo: "org/alchemy",
          number: 3010,
          kind: "issue",
          title: "D1 migration fails remotely with uppercase BEGIN",
        },
        {
          repo: "org/alchemy",
          number: 3011,
          kind: "issue",
          title:
            "migrations work locally but 400 on remote D1 (BEGIN TRANSACTION)",
        },
        // and one more A, arriving late
        {
          repo: "org/alchemy",
          number: 3004,
          kind: "issue",
          title: "OOM: pack ingest buffers whole packfile in memory",
        },
      ];

      await Effect.runPromise(
        handleCluster(world.deps, "engineering", events).pipe(
          Effect.provide(RuntimeContext.phantom),
        ),
      );

      // ONE thread for the pile
      const roots = world.childrenOf(undefined);
      expect(roots).toHaveLength(1);

      // exactly two root causes → two sub-threads
      const clusters = world
        .childrenOf(roots[0]!.id)
        .filter((post) => post.author === "manager")
        .filter((post) => /#\d{4}/.test(post.text));
      expect(clusters).toHaveLength(2);

      // the OOM cluster carries all four OOM issues, the D1 one both D1s
      const texts = clusters.map((post) => post.text);
      const oom = texts.find((text) => /3001/.test(text))!;
      for (const n of [3002, 3003, 3004]) {
        expect(oom).toMatch(new RegExp(String(n)));
      }
      const d1 = texts.find((text) => /3010/.test(text))!;
      expect(d1).toMatch(/3011/);

      // one engineer per root cause — two dispatches, not six
      expect(
        world.dispatches.filter((entry) => entry.agent === "engineer"),
      ).toHaveLength(2);
    },
    { timeout: 120_000 },
  );
});
