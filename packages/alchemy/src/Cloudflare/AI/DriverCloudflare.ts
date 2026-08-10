/**
 * The DURABLE OBJECT placement of the session engine — `AI.Driver`
 * for Cloudflare: ONE DO instance per session (named
 * `${term}/${key}`), verbs as RPC, the thread and inbox in DO
 * storage, reminders and crash recovery on the DO alarm, live views
 * on hibernatable WebSockets.
 *
 * The ALGORITHM and the LIFECYCLE are not here: both live in
 * {@link makeSessionEngine} (`DriverCore`) — the same code
 * `AI.DriverLocal` runs on a laptop. This module contributes only
 * what the substrate physically owns:
 *
 * - **storage** — {@link makeDurableObjectSessionStorage}: the shared
 *   `ThreadHandle` contract over the instance's own rows;
 * - **kick** — `state.waitUntil(engine.burst(key))`: execution rides
 *   DO events; parking is returning;
 * - **broadcast** — hibernatable WebSockets, re-read from the runtime
 *   per frame (no RAM session state to lose);
 * - **remind / recovery re-entry** — `remind:` rows + ONE alarm,
 *   re-armed to the earliest deadline;
 * - **verbs** — the {@link SessionRpc} surface, uniform across every
 *   agent, which is what makes delegation cross-DO for free.
 *
 * ## How a charter reaches the DO
 *
 * A charter is CODE and cannot cross the wire — and it doesn't need
 * to: the Worker and its DO classes share ONE memoized layer build
 * per isolate (`WorkerBridge.getSharedBuild`), and the class-level
 * `layers` slot IS that build. So the agent layers build on the DO
 * side too, their `interpret` calls record `term → {charter,
 * captured context}` in this module's registrations, and the
 * `AgentSessions` DO — declared here, discovered as a binding because
 * the layer yields it during init — closes over that same map. An
 * activating DO parses its own name and becomes that session.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Actor, SessionRef } from "../../AI/Agent.ts";
import { Driver, type Charter, type Interpretable } from "../../AI/Driver.ts";
import {
  makeMemoryThreadStorage,
  type ThreadStorageService,
} from "../../AI/ThreadStorage.ts";
import {
  makeSessionEngine,
  reminderInput,
  type SessionEngine,
} from "../../AI/DriverCore.ts";
import type { DriverError } from "../../AI/Errors.ts";
import { makeModel, Model } from "../../AI/Model.ts";
import { makeDurableObjectStore } from "../Workers/PersistentRefStore.ts";
import {
  AgentGateway,
  handleSessionSocketFrame,
  type SessionSocketClientFrame,
  type SessionSocketServerFrame,
} from "../../AI/SessionSocket.ts";
import type { HttpEffect } from "../../Http.ts";
import type { MainRpc } from "../../Platform.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { upgrade, type WebSocket } from "../Workers/WebSocket.ts";
import { Worker } from "../Workers/Worker.ts";
import {
  makeDurableObjectSessionStorage,
  REMIND,
  seqKey,
  seqOf,
} from "./DurableObjectThreadStorage.ts";

/** What one `interpret` call recorded — all a DO activation needs to
 *  BECOME a session of its term. */
interface RegisteredCharter {
  readonly charter: Charter;
  /** The charter's own Layer graph, captured at interpret — tools,
   *  doors, and delegates resolve from it as on the resident
   *  placement. */
  readonly context: Context.Context<never>;
  readonly term: Interpretable;
}

/** The DO name addressing one session of one term: `${term}/${key}`. */
const sessionName = (termName: string, key: string) => `${termName}/${key}`;

/** Split a DO name back into its term and key halves. The key may
 *  itself contain slashes (session keys are `${parent}/${agent}/${s}`),
 *  so only the FIRST segment is the term. */
const parseSessionName = (name: string) => {
  const at = name.indexOf("/");
  return at < 0
    ? { term: name, key: name }
    : { term: name.slice(0, at), key: name.slice(at + 1) };
};

/**
 * Tuning for the recovery machinery — optional; tests shrink it so
 * recovery is observable in seconds.
 */
export class DriverDurability extends Context.Service<
  DriverDurability,
  {
    /** Base delay before the recovery alarm re-enters a silent round
     *  (doubles per attempt, capped at 8×). @default 30 seconds */
    readonly recoverAfterMillis?: number;
    /** Re-entries on the same round before it is abandoned with an
     *  interruption note. @default 5 */
    readonly maxAttempts?: number;
  }
>()("alchemy/Cloudflare/AI/DriverDurability") {}

/**
 * A session's RPC surface — the {@link Actor} verbs, as one DO speaks
 * them. Uniform across every agent, which is what makes delegation
 * cross-DO for free: a door fired inside a session calls these on the
 * delegate's own instance.
 */
interface SessionRpc extends MainRpc<DurableObjectState> {
  readonly deliver: (
    input: unknown,
    options?: { readonly parent?: SessionRef; readonly wake?: boolean },
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly dispatch: (
    input: unknown,
    options?: { readonly parent?: SessionRef },
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
  readonly steer: (
    input: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly settle: (
    outcome: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, unknown, RuntimeContext>;
  /** The live-view seam: WebSocket attach + the session-socket frames. */
  readonly fetch: HttpEffect<DurableObjectState | RuntimeContext>;
  readonly webSocketMessage: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  readonly webSocketClose: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export { AgentGateway } from "../../AI/SessionSocket.ts";

/**
 * The `AI.Driver` for Cloudflare — no argument, and no class for the
 * user to declare: the sessions DO is declared in this module and
 * discovered as a binding because this layer YIELDS it while building.
 *
 * It requires `Worker` for exactly that reason: the binding attaches
 * to the host whose bundle carries the class, so this layer only
 * builds inside a Worker (or a DO of one). That is the whole
 * difference from `AI.DriverLocal`'s `Layer<Driver, never,
 * LanguageModel | ThreadStorage>` — the substrate is in the type.
 */
export const DurableObjectHost: Layer.Layer<
  Driver | AgentGateway,
  never,
  LanguageModel.LanguageModel | Worker
> = Layer.effectContext(
  Effect.gen(function* () {
    const languageModel = yield* LanguageModel.LanguageModel;
    const registrations = new Map<string, RegisteredCharter>();

    /**
     * The sessions namespace: ONE Durable Object for every agent — the
     * term prefix of the instance name says which charter an
     * activation becomes. Declared HERE, not by the user, and closed
     * over `registrations`, which the shared layer build populates
     * before any activation's constructor runs.
     */
    const sessions = yield* DurableObject<SessionRpc>()(
      "AgentSessions",
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const storage = state.storage;
        const store = makeDurableObjectSessionStorage(state);
        /**
         * WHO THIS ACTIVATION IS, read lazily. The constructor's outer
         * effect also runs at PLAN time — against a mock state with no
         * id — to discover this binding, so nothing here may touch the
         * instance eagerly. Every read below happens inside a
         * request-time effect.
         */
        let identity:
          | { readonly term: string; readonly key: string }
          | undefined;
        const me = {
          get term() {
            return (identity ??= parseSessionName(String(state.id.name))).term;
          },
          get key() {
            return (identity ??= parseSessionName(String(state.id.name))).key;
          },
        };

        const captured = yield* Effect.context<never>();
        const durability = Option.getOrElse(
          Context.getOption(captured, DriverDurability),
          () => ({}) as (typeof DriverDurability)["Service"],
        );
        const recoverAfter = durability.recoverAfterMillis ?? 30_000;

        // storage is a RUNTIME capability; everything here only ever
        // runs inside a DO event, so seal once
        const sealed = <A, E>(
          effect: Effect.Effect<A, E, RuntimeContext>,
        ): Effect.Effect<A, E> =>
          Effect.provide(effect, RuntimeContext.phantom);

        /**
         * ONE alarm, re-armed to the earliest of its consumers: the
         * next reminder, and any recovery deadline the engine asks
         * for. A stale alarm firing after the work is done just
         * parks — never cleared, only outraced.
         */
        const armAlarm = (extraDeadline?: number) =>
          sealed(
            Effect.gen(function* () {
              const reminders = yield* store.listRows<string>(REMIND);
              const deadlines = reminders.map(([k]) => seqOf(REMIND, k));
              if (extraDeadline !== undefined) deadlines.push(extraDeadline);
              const meta = yield* store.readMeta;
              if (meta.busy !== undefined && meta.settled === undefined) {
                deadlines.push(
                  meta.busy.since +
                    recoverAfter * 2 ** Math.min(meta.busy.attempts, 3),
                );
              }
              if (deadlines.length === 0) return;
              yield* storage
                .setAlarm(Math.min(...deadlines))
                .pipe(Effect.orDie);
            }),
          );

        /**
         * Fan a wire frame out to every attached socket. `sendIfOpen`
         * discipline: a closing socket's send throws and is IGNORED —
         * the client owns catch-up via `subscribe {fromSeq}`, so a
         * dropped frame is never an error, only a gap the cursor
         * closes. Sockets are re-read from the runtime each time (no
         * in-memory session map to rehydrate after hibernation).
         */
        const broadcast = (frame: SessionSocketServerFrame) =>
          sealed(
            Effect.gen(function* () {
              const attached = yield* state.getWebSockets();
              if (attached.length === 0) return;
              const data = JSON.stringify(frame);
              for (const socket of attached) {
                yield* Effect.ignore(Effect.try(() => socket.ws.send(data)));
              }
            }),
          );

        /**
         * The engine, built lazily on the first REQUEST-time touch
         * (the plan-time constructor must not read the instance's
         * identity). One activation = one session of one term; spawn
         * workers ride an in-memory sibling store — they are driven
         * inline by the spawn call and are not restorable by design.
         */
        let engineRef: SessionEngine | undefined;
        const memoryStore = makeMemoryThreadStorage();
        const stateStore = makeDurableObjectStore(state);
        const engine = Effect.sync((): SessionEngine => {
          if (engineRef !== undefined) return engineRef;
          const registration = registrations.get(me.term);
          if (registration === undefined) {
            throw new Error(
              `DriverCloudflare: no charter registered for '${me.term}' — is its Layer in the worker's layers slot?`,
            );
          }
          const model = Option.getOrElse(
            Context.getOption(registration.context, Model),
            () => makeModel(languageModel),
          );
          const singleSessionStorage: ThreadStorageService = {
            open: (term, key) =>
              key === me.key
                ? Effect.succeed(store.handle)
                : memoryStore.open(term, key),
            // restore is per-activation on this placement — a DO
            // revives its own session when addressed
            keys: () => Effect.succeed([]),
            remove: (term, key) => memoryStore.remove(term, key),
          };
          engineRef = makeSessionEngine({
            driver: "DriverCloudflare",
            term: me.term,
            charter: registration.charter,
            context: registration.context,
            storage: singleSessionStorage,
            model,
            // execution rides DO events; the burst is contained (it
            // never fails), so waitUntil can never be poisoned
            kick: (key) => sealed(state.waitUntil(engineRef!.burst(key))),
            broadcast: (key, frame) =>
              key === me.key ? broadcast(frame) : Effect.void,
            // the CLOCK, durable by construction: a row plus the DO
            // alarm — delivery comes back through `alarm` below
            remind: (key, fireAtMillis, note) =>
              key === me.key
                ? sealed(
                    Effect.gen(function* () {
                      yield* storage.put(seqKey(REMIND, fireAtMillis), note);
                      yield* armAlarm();
                    }),
                  )
                : Effect.void,
            scheduleReentry: (_key, delayMillis) =>
              armAlarm(Date.now() + delayMillis),
            stateStore: () => stateStore,
            // handlers run INSIDE the DO's event, so the runtime
            // capability is already satisfied — seal it once here
            wrapHandler: (handler) => (params) =>
              Effect.provide(
                handler(params),
                RuntimeContext.phantom,
              ) as Effect.Effect<any, any>,
            maxAttempts: durability.maxAttempts,
            recoverAfterMillis: durability.recoverAfterMillis,
          });
          return engineRef;
        });

        return Effect.succeed<SessionRpc>({
          /**
           * The LIVE VIEW attaches here (via {@link AgentGateway}):
           * accept the WebSocket and hibernate freely — there is no
           * in-memory session state to lose, because `broadcast`
           * re-reads the attached sockets from the runtime every time.
           */
          fetch: Effect.gen(function* () {
            const [response] = yield* upgrade();
            return response;
          }),
          webSocketMessage: (socket, message) =>
            Effect.gen(function* () {
              const host = yield* (yield* engine).socketHost(me.key);
              yield* handleSessionSocketFrame(host, (frame) =>
                Effect.ignore(socket.send(JSON.stringify(frame))),
              )(
                JSON.parse(
                  typeof message === "string"
                    ? message
                    : new TextDecoder().decode(message),
                ) as SessionSocketClientFrame,
              );
            }).pipe(
              // a malformed frame must never kill the socket's DO
              Effect.catchDefect((defect) =>
                Effect.logWarning(`[session-socket] bad frame: ${defect}`),
              ),
              Effect.provide(RuntimeContext.phantom),
            ) as Effect.Effect<void>,
          webSocketClose: (socket, code, reason) =>
            Effect.ignore(socket.close(code, reason)),
          deliver: (
            input: unknown,
            options?: { parent?: SessionRef; wake?: boolean },
          ) =>
            Effect.gen(function* () {
              yield* (yield* engine).send(input, {
                key: me.key,
                parent: options?.parent,
                wake: options?.wake,
              });
            }),
          dispatch: (input: unknown, options?: { parent?: SessionRef }) =>
            Effect.gen(function* () {
              return yield* (yield* engine).dispatch(input, {
                key: me.key,
                parent: options?.parent,
              });
            }),
          steer: (input: unknown) =>
            Effect.gen(function* () {
              yield* (yield* engine).send(input, { key: me.key });
            }),
          settle: (
            outcome: unknown,
          ): Effect.Effect<void, never, RuntimeContext> =>
            Effect.gen(function* () {
              yield* (yield* engine).settle(me.key, outcome, { admit: true });
            }),
          /**
           * The single alarm serves BOTH clocks: due reminders become
           * ordinary inputs, and an open round's recovery deadline
           * re-enters the burst. Re-arming happens AFTER the burst so
           * the alarm reflects the round's final state.
           */
          alarm: () =>
            Effect.gen(function* () {
              const now = Date.now();
              const active = yield* engine;
              const rows = yield* store.listRows<string>(REMIND);
              const due = rows.filter(([k]) => seqOf(REMIND, k) <= now);
              for (const [, note] of due) {
                yield* active.send(reminderInput(note), { key: me.key });
              }
              if (due.length > 0) {
                yield* storage.delete(due.map(([k]) => k)).pipe(Effect.orDie);
              }
              // recovery deadline: re-enter the round (contained —
              // a burst never fails)
              yield* active.burst(me.key);
              yield* armAlarm();
            }).pipe(
              // a failing alarm event must be CONTAINED: workerd's own
              // alarm retry would race our bounded one (and a repeated
              // failure resets the object) — log, best-effort re-arm,
              // and let our recovery machinery own the re-entry
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logError(
                    `DriverCloudflare alarm for '${me.term}/${me.key}' failed (contained)`,
                    cause,
                  );
                  yield* Effect.ignore(armAlarm());
                }),
              ),
            ),
        });
      }),
    );
    let minted = 0;
    const mintPrefix = crypto.randomUUID().slice(0, 8);

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const termName = term["~alchemy/Name"];
        registrations.set(termName, {
          charter,
          context: yield* Effect.context<never>(),
          term,
        });

        const stub = (key: string) =>
          sessions.getByName(sessionName(termName, key));
        const mint = () => `session-${mintPrefix}-${minted++}`;

        return {
          send: (item: unknown, options?: Parameters<Actor["send"]>[1]) =>
            stub(options?.key ?? mint())
              .deliver(item, { parent: options?.parent, wake: options?.wake })
              .pipe(Effect.orDie, Effect.asVoid),
          dispatch: (
            item: unknown,
            options?: Parameters<Actor["dispatch"]>[1],
          ) =>
            stub(options?.key ?? mint())
              .dispatch(item, { parent: options?.parent })
              .pipe(Effect.orDie),
          steer: ((first: unknown, second?: unknown) =>
            second === undefined
              ? Effect.die(
                  new Error(
                    "DriverCloudflare: steer requires a key — steer(key, input)",
                  ),
                )
              : stub(first as string)
                  .steer(second)
                  .pipe(Effect.orDie, Effect.asVoid)) as Actor["steer"],
          settle: (sessionKey: string, outcome: unknown) =>
            stub(sessionKey).settle(outcome).pipe(Effect.orDie, Effect.asVoid),
          interrupt: () =>
            Effect.die(
              new Error(
                "DriverCloudflare: interrupt() is process-local; settle sessions by key instead",
              ),
            ),
        } as Actor;
      }) as Effect.Effect<Actor, DriverError, never>;

    /** The gateway: route a WebSocket upgrade into the session's own
     *  DO. */
    const attach = (
      term: string,
      key: string,
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      sessions
        .getByName(sessionName(term, key))
        .fetch(request)
        .pipe(Effect.orDie) as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        RuntimeContext
      >;

    return Context.add(Context.make(Driver, { interpret }), AgentGateway, {
      attach,
    });
  }),
);

/**
 * The composed Cloudflare driver: the Durable Object PLACEMENT of the
 * session engine over Durable Object storage — one name for the
 * assembly every Worker wants.
 */
export const DriverCloudflare = DurableObjectHost;
