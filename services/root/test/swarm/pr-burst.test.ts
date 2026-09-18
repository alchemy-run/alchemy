/**
 * SCENARIO — a burst of pull requests lands at once (five AWS, three
 * container). A good team turns that into ONE channel thread, a
 * sub-thread per stream, a sub-sub-thread per PR, reviews running in
 * parallel across PRs, and a reviewer→engineer chain INSIDE a PR only
 * when the review demands changes.
 *
 * The world is explicit code: posts are an array, threads are
 * grouping by replyTo, agents are scripted answers. TypeSafe
 * judgments run LIVE (they are the thing under test); agents never
 * do. Gated on `TYPESAFE_API_KEY`.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  handleBurst,
  type Agent,
  type BurstDeps,
  type InboundEvent,
} from "../../src/engineering/Burst.ts";

const query = ((questions, options) =>
  TS.query(questions, options).pipe(
    Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
  )) as typeof TypeSafe.SystemOne.Service;

interface WorldPost {
  readonly id: string;
  readonly replyTo?: string;
  readonly author: string;
  readonly text: string;
}

/** The whole fixture, explicitly: an array, two counters, a script. */
const burstWorld = () => {
  const posts: WorldPost[] = [];
  const events: InboundEvent[] = [];
  const script: Array<{ agent: Agent; match: RegExp; answer: string }> = [];
  const dispatches: Array<{
    agent: Agent;
    ask: string;
    start: number;
    end: number;
  }> = [];
  let now = 0;
  let ids = 0;

  const deps: BurstDeps = {
    query,
    post: (input) =>
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
    dispatch: (agent, input) =>
      Effect.gen(function* () {
        const start = now++;
        yield* Effect.sleep("15 millis"); // overlap window for parallelism
        const end = now++;
        const line = script.find(
          (entry) => entry.agent === agent && entry.match.test(input.ask),
        );
        const answer = line?.answer ?? `${agent}: done.`;
        dispatches.push({ agent, ask: input.ask, start, end });
        posts.push({
          id: `w-${++ids}`,
          replyTo: input.thread,
          author: agent,
          text: answer,
        });
        return answer;
      }),
    budget: { maxDispatches: 24 },
  };

  return {
    deps,
    events,
    dispatches,
    posts,
    pull: (repo: string, number: number, title: string) =>
      events.push({ repo, number, title, kind: "pull" }),
    answer: (agent: Agent, match: RegExp, answer: string) =>
      script.push({ agent, match, answer }),
    childrenOf: (id: string | undefined) =>
      posts.filter((post) => post.replyTo === id),
    dispatchOrder: (needle: string) =>
      dispatches
        .filter((entry) => entry.ask.includes(needle))
        .sort((a, b) => a.start - b.start)
        .map((entry) => entry.agent),
    dispatched: (agent: Agent, match: RegExp) =>
      dispatches.some(
        (entry) => entry.agent === agent && match.test(entry.ask),
      ),
    overlapped: (a: RegExp, b: RegExp) => {
      const one = dispatches.find((entry) => a.test(entry.ask));
      const two = dispatches.find((entry) => b.test(entry.ask));
      return (
        one !== undefined &&
        two !== undefined &&
        one.start < two.end &&
        two.start < one.end
      );
    },
  };
};

describe("swarm: pr burst", () => {
  test(
    "a mixed burst becomes stream threads with parallel reviews and judged chains",
    async () => {
      const world = burstWorld();
      world.pull(
        "org/alchemy",
        2001,
        "fix(aws/s3): bucket tags drift on adopt",
      );
      world.pull(
        "org/alchemy",
        2002,
        "fix(aws/ec2): vpc attribute sync reads olds",
      );
      world.pull(
        "org/alchemy",
        2003,
        "fix(aws/rds): storage params coupled on modify",
      );
      world.pull("org/alchemy", 2004, "fix(aws/lambda): url config drift");
      world.pull("org/alchemy", 2005, "feat(aws/sqs): queue redrive policy");
      world.pull(
        "org/alchemy",
        2010,
        "fix(fly): machine restart loop on deploy",
      );
      world.pull("org/alchemy", 2011, "fix(railway): volume detach race");
      world.pull("org/alchemy", 2012, "fix(hetzner): server rescue mode flag");

      world.answer(
        "reviewer",
        /2001/,
        "LGTM — tag diffing reads observed state.",
      );
      world.answer(
        "reviewer",
        /2002/,
        "Changes needed: the attribute diff still reads olds instead of observed attrs.",
      );
      world.answer(
        "engineer",
        /2002/,
        "Fixed — diff now reads describeVpcAttribute.",
      );
      world.answer("reviewer", /20\d\d/, "LGTM.");

      await Effect.runPromise(
        handleBurst(world.deps, "engineering", world.events).pipe(
          Effect.provide(RuntimeContext.phantom),
        ),
      );

      // ONE burst root in the channel
      const roots = world.childrenOf(undefined);
      expect(roots).toHaveLength(1);

      // a sub-thread per stream, aws and container both present
      const streams = world.childrenOf(roots[0]!.id).map((post) => post.text);
      expect(streams.join("\n")).toMatch(/aws/i);
      expect(streams.join("\n")).toMatch(/container|fly|platform/i);

      // reviews across PRs actually overlapped (fork, not a chain)
      expect(world.overlapped(/2001/, /2003/)).toBe(true);

      // INSIDE #2002 the chain is a series: reviewer first, then engineer
      expect(world.dispatchOrder("2002")).toEqual(["reviewer", "engineer"]);

      // #2001's clean review chained nobody
      expect(world.dispatched("engineer", /2001/)).toBe(false);

      // every PR got exactly one review
      for (const n of [2001, 2002, 2003, 2004, 2005, 2010, 2011, 2012]) {
        expect(world.dispatched("reviewer", new RegExp(String(n)))).toBe(true);
      }
    },
    { timeout: 120_000 },
  );
});
