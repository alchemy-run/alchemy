import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RuntimeContext } from "alchemy";

/**
 * Tracks which files the agent has read this session so `write`/`edit` can
 * enforce OpenCode's read-before-mutate rule: you must `read` a file before
 * overwriting or editing it.
 *
 * Backed by the session Durable Object's KV storage (one key per path), so the
 * read-set survives across turns and isolate restarts. KV is a better fit than
 * SQL here: it's a plain set of paths with no querying, and per-key writes avoid
 * the read-modify-write races a single serialized row would invite.
 */
export class ReadTracker extends Context.Service<
  ReadTracker,
  {
    /** Record that `path` has been read. */
    markRead: (path: string) => Effect.Effect<void, never, RuntimeContext>;
    /** Whether `path` has been read this session. */
    hasRead: (path: string) => Effect.Effect<boolean, never, RuntimeContext>;
  }
>()("forked/agent/ReadTracker") {}

/** Durable-Object-storage-backed implementation of {@link ReadTracker}. */
export const ReadTrackerObject = Layer.effect(
  ReadTracker,
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const key = (path: string) => `read:${path}`;
    return {
      markRead: (path) => state.storage.put(key(path), true),
      hasRead: (path) =>
        state.storage
          .get<boolean>(key(path))
          .pipe(Effect.map((value) => value === true)),
    };
  }),
);
