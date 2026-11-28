import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { ProcessService, ProcessTag, Session } from "./Process.ts";
import type { SessionEntry, SessionEvent, SessionItem, SessionState } from "./Session.ts";
import { StateStore, stateStoreOf } from "./State.ts";

/** One message a scripted session is answering. */
export interface Turn {
  /** The session's key. */
  readonly key: string;
  /** What it was sent. */
  readonly text: string;
}

/**
 * A process played by code in place of a model: a stand-in for tests. Each
 * message a session is sent is stored as a `user` item, answered by
 * `answer`, and the answer stored as an `assistant` item, with the status
 * going from `working` to `idle` around it. Nothing else is stored, and no
 * harness, model or sandbox is needed.
 *
 * `answer` is where the test does what a session would have done with its
 * tools: send the commands the prose mentions, and read and write the
 * session's state (`AI.State`).
 *
 * **Example:** A Triage that labels every issue a bug
 * ```typescript
 * const TriagePlayed = AI.scripted(
 *   Triage,
 *   Effect.gen(function* () {
 *     const issues = yield* Issue;
 *     return Effect.fn(function* ({ key }: AI.Turn) {
 *       yield* issues.send(new LabelIssue({ issueId: IssueId.make(key), label: "bug" }));
 *       return "Labeled bug.";
 *     }, Effect.orDie);
 *   }),
 * );
 *
 * const BoardInMemory = Board.layer(IssueWorkLive).pipe(Layer.provide(Domain.InMemory));
 *
 * // The board's policy holds Triage, and Triage sends the board's commands.
 * const TriageInMemory = AI.layerInMemory(TriagePlayed.pipe(Layer.provide(BoardInMemory)));
 *
 * const Live = BoardInMemory.pipe(Layer.provideMerge(TriageInMemory));
 * ```
 */
export const scripted = <Service, R = never>(
  process: ProcessTag<Service, string, any>,
  build: Effect.Effect<
    (turn: Turn) => Effect.Effect<string, never, RuntimeContext | StateStore>,
    never,
    R
  >,
): Layer.Layer<Service, never, R> =>
  Layer.effect(
    process as unknown as Context.Key<Service, ProcessService<any>>,
    Effect.gen(function* () {
      const answer = yield* build;
      const sessions = new Map<string, Session>();
      // Every session's state, for as long as the Layer lives.
      const stored = new Map<string, string>();
      const values = {
        get: (key: string) => Effect.sync(() => stored.get(key)),
        put: (key: string, value: string) => Effect.sync(() => void stored.set(key, value)),
      };
      const make = (key: string): Session => {
        const store = stateStoreOf(values, key);
        const state = <A>(declared: { readonly in: (store: StateStore["Service"]) => A }) =>
          declared.in(store);
        const items: Array<SessionEntry> = [];
        const seen = new Set<string>();
        let working = 0;
        /** Everyone following the session now. */
        const followers = new Set<(event: SessionEvent) => void>();
        const publish = (event: SessionEvent) =>
          Effect.sync(() => {
            for (const follower of followers) follower(event);
          });
        const status = (): SessionEvent => ({
          type: "status",
          status: working > 0 ? "working" : "idle",
          queued: [],
        });
        const keep = (item: SessionItem) =>
          Effect.suspend(() => {
            const entry = { seq: items.length + 1, item };
            items.push(entry);
            return publish({ type: "item", ...entry });
          });
        const turn = (text: string, requestId: string | undefined) =>
          Effect.gen(function* () {
            // The same id is answered once.
            if (requestId !== undefined && seen.has(requestId)) return "";
            if (requestId !== undefined) seen.add(requestId);
            working++;
            yield* publish(status());
            yield* keep({ type: "user", text });
            // `answer` stands in for the session's tools, so it has the session's state.
            const reply = yield* Effect.provideService(answer({ key, text }), StateStore, store);
            yield* keep({ type: "assistant", text: reply, toolCalls: [] });
            working--;
            yield* publish(status());
            return reply;
          });
        return {
          send: (text, options) => Effect.asVoid(turn(text, options?.requestId)),
          steer: (text, options) => Effect.asVoid(turn(text, options?.requestId)),
          prompt: (text, options) =>
            Effect.map(turn(text, options?.requestId), (reply) => ({ text: reply })),
          withdraw: () => Effect.void,
          interrupt: Effect.void,
          state: state as Session["state"],
          events: (options) =>
            Stream.callback<SessionEvent>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  // The status, the stored items, then what happens next: nothing falls between.
                  const stored = items.filter((entry) => entry.seq > (options?.after ?? 0));
                  const last = stored.at(-1)?.seq ?? options?.after ?? 0;
                  Queue.offerAllUnsafe(queue, [
                    status(),
                    ...stored.map((entry) => ({ type: "item" as const, ...entry })),
                  ]);
                  const follower = (event: SessionEvent) => {
                    if (event.type !== "item" || event.seq > last) Queue.offerUnsafe(queue, event);
                  };
                  followers.add(follower);
                  return follower;
                }),
                (follower) => Effect.sync(() => void followers.delete(follower)),
              ),
            ),
          status: Effect.sync((): SessionState => ({
            status: working > 0 ? "working" : "idle",
            queued: [],
          })),
          history: (options) =>
            Effect.sync(() => {
              const after = options?.after ?? 0;
              const take = options?.take ?? 50;
              const page = items.filter((entry) => entry.seq > after).slice(0, take);
              const next = page.at(-1)?.seq;
              return next !== undefined && next < items.length
                ? { items: page, next }
                : { items: page };
            }),
        };
      };
      return {
        start: () => Effect.void,
        get: (key: string) => {
          let session = sessions.get(key);
          if (session === undefined) sessions.set(key, (session = make(key)));
          return session;
        },
        "~exists": (key: string) => Effect.sync(() => sessions.has(key)),
        "~state": (key: string) => Effect.succeed(stateStoreOf(values, key)),
      } satisfies ProcessService<any>;
    }),
  );
