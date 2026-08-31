import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { RuntimeContext } from "../RuntimeContext.ts";
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
     * STOP one session from the outside — the operator's off switch.
     * Settles it (terminal: children cascade, the `settled`
     * observation lands, attached views see the end); idempotent on
     * an already-settled or never-seen key.
     */
    readonly stop: (
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
