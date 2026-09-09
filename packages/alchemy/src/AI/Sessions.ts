import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { SessionObservation } from "./Events.ts";
import type { SessionSummary } from "./SessionIndex.ts";

/**
 * The SESSIONS surface — the one service app code yields to see the
 * living population from OUTSIDE: `list` them all, `attach` a live
 * socket to one. The duality of {@link Thread}: inside a charter,
 * `Thread` is THIS session's self-view; out here, `Sessions` is
 * everyone's view of all of them.
 *
 * Provided BY THE DRIVER, because both verbs are placement knowledge:
 * `attach` must route a WebSocket upgrade to wherever the session
 * physically lives (an in-process fiber locally; the session's own
 * Durable Object on Cloudflare — hibernatable sockets are DO-owned,
 * so the upgrade is forwarded, never proxied), and `list` delegates
 * to the {@link SessionIndex} composed into the assembly (absent an
 * index, the population is unlistable and `list` answers empty).
 *
 * `SessionIndex` remains the IMPLEMENTER's seam — the store behind
 * `list`, fed by the driver's `Events` — and is never yielded by
 * app code.
 *
 * ```ts
 * const sessions = yield* AI.Sessions;
 * yield* sessions.list();
 * // in a fetch handler: ws(s)://host/attach/ReviewBot/owner%2Frepo%237
 * return yield* sessions.attach(term, key, request);
 * ```
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    /** Every known session, newest activity first. */
    readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>>;
    /** Attach a live view (the session-socket protocol) to ONE
     *  session, by WebSocket upgrade. */
    readonly attach: (
      term: string,
      key: string,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      RuntimeContext
    >;
    /**
     * The durable TRANSCRIPT of one session — its observation log,
     * oldest first — read from wherever it lives (the shared
     * `ThreadStorage` locally; the session's own Durable Object on
     * Cloudflare). A snapshot for a client that is about to attach:
     * hydrate from this, then tail the socket at the watermark. A
     * never-seen key answers empty — the chat exists from the first
     * visit, before any input.
     */
    readonly history: (
      term: string,
      key: string,
    ) => Effect.Effect<
      ReadonlyArray<SessionObservation>,
      never,
      RuntimeContext
    >;
    /**
     * OPEN one session by name — the operator's "new session": the
     * durable `admitted` row lands (so the session LISTS, idle, for
     * every client, before any input) without running the charter's
     * per-session init; that still happens on the first input.
     * Idempotent on a known key. Without this, a session existed only
     * as the tab that named it: an unsent first message and it was
     * gone the moment the tab lost focus.
     */
    readonly open: (
      term: string,
      key: string,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * SEND one input to a session BY NAME — `Agent.send` without the
     * agent's service in hand. This is how a domain object that OWNS
     * a session (a thread's DO fronting its thread agent) talks to
     * it from a Layer that must not depend on the agent's own Layer
     * (which depends back on the object): the term and key address
     * the session, the driver finds the charter. Same semantics as
     * `Agent.send`: the input is admitted to the session's inbox;
     * `wake: false` records it without starting a round — the next
     * sampling hears it. Fire-and-forget; the session answers into
     * its own conversation, never to the caller.
     */
    readonly send: (
      term: string,
      key: string,
      input: unknown,
      options?: { readonly wake?: boolean },
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * STOP one session from the outside — the operator's off switch.
     * Settles it (terminal: children cascade, the `settled`
     * observation lands, attached views see the end) and CUTS the
     * round in flight — its sampling, its tool handlers — awaiting
     * their end, so a stopped engineer mid-command has stopped when
     * this returns; idempotent on an already-settled or never-seen
     * key.
     */
    readonly stop: (
      term: string,
      key: string,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * INTERRUPT one session's in-flight round — the operator's stop
     * button, as opposed to `stop`'s off switch. The running sampling
     * or tool handlers are interrupted and the round abandoned: an
     * `aborted` observation lands (attached views see the turn end),
     * the model gets a note that the work was cut short, and the
     * workers the round dispatched settle. The session itself stays
     * alive and parked — the next input opens a fresh round. A parked,
     * settled, or never-seen key is a no-op.
     */
    readonly interrupt: (
      term: string,
      key: string,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * RESUME a stopped session — the operator's undo for `stop`: the
     * settled tombstone is cleared and the session accepts input
     * again (its machine, if suspended, wakes on the next call).
     * Idempotent on a live or never-seen key. Children settled by the
     * stop's cascade stay settled.
     */
    readonly resume: (
      term: string,
      key: string,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * REDACT rows from one session's transcript — the operator
     * deleting messages from a chat. Observation seqs are minted by
     * the session's durable cursor and never reused, so a seq names
     * its row forever; unknown seqs are ignored. Projection-only:
     * the thread messages (the model's working context) are
     * untouched — the model may still remember what the operator no
     * longer sees.
     */
    readonly redact: (
      term: string,
      key: string,
      seqs: ReadonlyArray<number>,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /**
     * DELETE one session — stop it, then erase it: the transcript
     * (its `ThreadStorage` rows), its clock, and its index row. After
     * `remove` the session no longer lists and its history is gone.
     * Idempotent.
     *
     * `options.machine` controls the shared machine's fate: `true`
     * (the default) also terminates the session's sandbox machine —
     * "removed session ⇒ no machine". Pass `false` when sibling
     * threads still share the machine (the caller consults its
     * directory); the machine then lives on for them, and the
     * platform's idle policy reaps it if everyone is gone.
     */
    readonly remove: (
      term: string,
      key: string,
      options?: { readonly machine?: boolean },
    ) => Effect.Effect<void, never, RuntimeContext>;
  }
>()("alchemy/AI/Sessions") {}
