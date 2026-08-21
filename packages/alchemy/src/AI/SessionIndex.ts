import * as Context from "effect/Context";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Events, type SessionObservation } from "./Events.ts";

/** One session's index id: `${term}:${key}`. */
export const sessionId = (term: string, key: string) => `${term}:${key}`;

/**
 * One session, as the index lists it — the board row: who it is,
 * whether it is working, and what it was born to do. Everything else
 * about a session (its transcript, its live tail) is served from the
 * session itself (`ThreadStorage` observations over the socket); the
 * index carries only what a CROSS-SESSION listing needs.
 */
export interface SessionSummary {
  readonly id: string;
  readonly term: string;
  readonly key: string;
  /** `running` = actively sampling; `idle` = parked until the world
   *  moves. */
  readonly status: "running" | "idle" | "settled" | "crashed";
  /** Samplings so far (assistant observations). */
  readonly ticks: number;
  /** When the session was admitted. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The id of the session that dispatched this one, if any. */
  readonly parent: string | undefined;
  /** The session's FIRST input (truncated) — the work item it was
   *  born with. */
  readonly firstInput: string | undefined;
}

/**
 * The SESSION INDEX — the one {@link Events} consumer the core
 * ships, because every UI needs it and no session can answer it: the
 * cross-session directory. `ThreadStorage` is sharded per session (one
 * Durable Object each on Cloudflare), so "list the sessions, newest
 * activity first" requires an aggregate fed by the stream.
 *
 * Deliberately summaries-ONLY: transcripts belong to the session
 * (`ThreadStorage.observations`), the live tail to its socket. An
 * implementation chooses persistence — {@link MemorySessionIndex} for
 * a single process, sqlite/DO layers in userland or the substrate
 * packages.
 */
export class SessionIndex extends Context.Service<
  SessionIndex,
  {
    /** Feed one stream observation into the index. */
    readonly ingest: (observation: SessionObservation) => Effect.Effect<void>;
    /** Every known session, newest activity first. */
    readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>>;
    /** Drop one session's row (`Sessions.remove` erases the directory
     *  entry along with the transcript). Unknown ids are a no-op. */
    readonly remove: (id: string) => Effect.Effect<void>;
  }
>()("alchemy/AI/SessionIndex") {}

/**
 * Wire the index INTO the driver's {@link Events} — provide this
 * beside the driver Layer, over ONE shared {@link SessionIndex}
 * instance (the same const the HTTP surface reads; layers memoize by
 * reference).
 */
export const SessionIndexStream: Layer.Layer<Events, never, SessionIndex> =
  Layer.effect(
    Events,
    Effect.map(SessionIndex, (index) => ({
      emit: (observation) => Effect.ignore(index.ingest(observation)),
    })),
  );
