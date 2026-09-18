import * as AI from "alchemy/AI";
import * as TypeSafe from "alchemy/TypeSafe";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Posts } from "../chat/Posts.ts";
import { lineage, ROOT } from "../Lineage.ts";

/** Per-invocation session key — the same scheme ChannelsApi mints. */
const invocationKey = (standing: string, post: string) =>
  standing === ROOT ? `${ROOT}::head::${post}` : `${standing}::${post}`;
import type { Agent, SwarmDeps } from "./Swarm.ts";

/** Where each colleague answers — the same addresses the DMs use. */
const ADDRESS: Record<Agent, { term: string; key: string }> = {
  head: { term: "Head", key: ROOT },
  manager: { term: "Manager", key: lineage("manager") },
  engineer: { term: "Engineer", key: lineage("engineer") },
  reviewer: { term: "Reviewer", key: lineage("reviewer") },
};

const clip = (value: string) =>
  value.length > 8_000 ? `${value.slice(0, 8_000)}…` : value;

/**
 * The walkers' deps, LIVE: posts land in the real channel (author
 * `swarm` for scaffolding), and a dispatch is the proven
 * per-invocation pattern — the agent answers in its own session, the
 * reply lands in the walker's thread under the agent's name.
 */
export const swarmDeps = Effect.gen(function* () {
  const posts = yield* Posts;
  const sessions = yield* AI.Sessions;
  const query = yield* TypeSafe.SystemOne;

  return (channel: string): SwarmDeps => ({
    query,
    budget: { maxDispatches: 24 },
    post: (input) =>
      Effect.gen(function* () {
        const minted = yield* Clock.currentTimeMillis;
        const id = `p-${minted.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        yield* posts.post({
          id,
          ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
          channel,
          author: input.author ?? "swarm",
          text: input.text,
          status: "settled",
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        });
        return id;
      }).pipe(Effect.orDie),
    dispatch: (agent, input) =>
      Effect.gen(function* () {
        const address = ADDRESS[agent];
        const minted = yield* Clock.currentTimeMillis;
        const id = `${input.thread}-${agent}-${minted.toString(36)}`;
        const outcome = yield* sessions.dispatch(
          address.term,
          invocationKey(address.key, id),
          { id, author: "swarm", content: input.ask },
        );
        const answer = typeof outcome === "string" ? outcome.trim() : "";
        if (answer.length > 0) {
          yield* posts.post({
            id: `${id}-answer`,
            replyTo: input.thread,
            channel,
            author: agent,
            text: clip(answer),
            status: "settled",
          });
        }
        return answer;
      }).pipe(Effect.orDie),
  });
});
