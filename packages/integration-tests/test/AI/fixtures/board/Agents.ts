import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import * as Alchemy from "alchemy";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Fast, FastLlama } from "../Processes.ts";
import { Board, BoardHandlers, Labeler, Triager } from "./Board.ts";
import type { IssueId } from "./Issue.id.ts";
import { IssueSession, RecordActivity } from "./Session.ts";
import { Triage } from "./Triage.ts";

/** What the object of one issue answers. */
interface Agent {
  readonly start: (issue: IssueId) => Effect.Effect<void, never, RuntimeContext>;
  readonly tell: (
    issue: IssueId,
    text: string,
    id: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  /** Reset the object, as an eviction in the middle of its work does. */
  readonly crash: () => Effect.Effect<void, never, RuntimeContext>;
  /** What the issue's session was told and did, as its harness stores it. */
  readonly transcript: (issue: IssueId) => Effect.Effect<string, never, RuntimeContext>;
}

/** The objects, one per issue. */
interface Agents {
  readonly getByName: (issue: string) => Agent;
}

/**
 * The board on Durable Objects. Its triager is the object of each issue,
 * reached through whichever handle on the objects the caller has.
 */
const boardOver = <R>(agents: Effect.Effect<Agents, never, R>) =>
  Board.layer(BoardHandlers).pipe(
    Layer.provide(
      Layer.mergeAll(
        DomainCloudflare.layerDurableObjects(),
        Triager.toLayer(
          Effect.map(agents, (agents) => ({
            start: ({ issue }) => agents.getByName(issue).start(issue),
            tell: ({ issue, text, id }) => agents.getByName(issue).tell(issue, text, id),
          })),
        ),
      ),
    ),
  );

/** Inside an object, the objects are its own namespace. */
const own = Effect.map(
  Cloudflare.DurableObjectScope,
  (self) => self as Cloudflare.DurableObject<Agent>,
);

/** What the Triage process runs with: Pi, a model, and the board it reports to. */
const Live = Layer.mergeAll(Pi.HarnessLive, AI.DefaultModel(Fast), boardOver(own)).pipe(
  Layer.provide(Layer.mergeAll(PiCloudflare.DurableObjectStorage, FastLlama)),
);

/** Where an issue's Triage session runs, and what the board may ask of it. */
export default class BoardAgents extends Cloudflare.DurableObject<BoardAgents>()(
  "BoardAgents",
  Effect.gen(function* () {
    const triage = yield* Triage;
    const sessions = yield* IssueSession;
    const state = yield* Cloudflare.DurableObjectState;

    /** Send the board a batch of what the session reported. */
    const report = (
      issue: IssueId,
      status: AI.SessionEvent & { type: "status" },
      items: ReadonlyArray<AI.SessionEntry>,
    ) =>
      sessions.send(
        new RecordActivity({ issueId: issue, status: status.status, queued: status.queued, items }),
      );

    /**
     * Record the session as it happens: every event after the last item the
     * board has, a batch at a time. It runs for as long as this instance does.
     */
    const live = Effect.fn(function* (issue: IssueId) {
      const recorded = yield* sessions.get(IssueSession.ref(issue));
      let status: AI.SessionEvent & { type: "status" } = {
        type: "status",
        status: recorded.status,
        queued: recorded.queued,
      };
      yield* triage
        .get(issue)
        .events({ after: recorded.seq })
        .pipe(
          Stream.groupedWithin(50, "100 millis"),
          Stream.runForEach((batch) => {
            const events = Array.from(batch);
            status = events.findLast((event) => event.type === "status") ?? status;
            return report(
              issue,
              status,
              events.flatMap((event) =>
                event.type === "item" ? [{ seq: event.seq, item: event.item }] : [],
              ),
            );
          }),
        );
    });

    /**
     * Record everything the session has stored that the board lacks, and say
     * whether the session is done: idle, with nothing queued.
     */
    const catchUp = Effect.fn(function* (issue: IssueId) {
      const session = triage.get(issue);
      const first = yield* Stream.runHead(session.events());
      const status = Option.getOrUndefined(first);
      if (status?.type !== "status") return true;
      let after = (yield* sessions.get(IssueSession.ref(issue))).seq;
      while (true) {
        const page = yield* session.history({ after, take: 100 });
        yield* report(issue, status, page.items);
        if (page.next === undefined) break;
        after = page.next;
      }
      return status.status === "idle" && status.queued.length === 0;
    });

    return Effect.gen(function* () {
      let recording = false;
      /** Start recording live, once for as long as this instance lives. */
      const follow = (issue: IssueId) =>
        Effect.suspend(() => {
          if (recording) return Effect.void;
          recording = true;
          return state.waitUntil(
            live(issue).pipe(Effect.ensuring(Effect.sync(() => void (recording = false)))),
          );
        });

      /**
       * What makes recording durable: a job on the object's alarm, kept in
       * its storage. It wakes the object, records what the board lacks, and
       * comes back until the session is done, however often the object is
       * evicted in between.
       */
      const again = (issue: IssueId): Effect.Effect<void, never, RuntimeContext> =>
        onRecord.schedule(issue, { after: "5 seconds", payload: issue }).pipe(Effect.orDie);
      const onRecord: Alchemy.Callback<IssueId> = yield* Alchemy.makeCallback(
        "record",
        Effect.fn(function* (issue: IssueId) {
          yield* follow(issue);
          if (!(yield* catchUp(issue))) yield* again(issue);
        }, Effect.orDie),
      );
      /** Record from now until the session is done. */
      const record = (issue: IssueId) => Effect.andThen(follow(issue), again(issue));

      return {
        // Every command the session sends is sent as this labeler.
        start: (issue) =>
          triage
            .start(issue, { as: Labeler.context({ name: "triage-bot" }) })
            .pipe(
              Effect.andThen(
                triage.get(issue).send(`The issue is ${issue}.`, { requestId: "start" }),
              ),
              Effect.andThen(record(issue)),
              Effect.orDie,
            ),
        tell: (issue, text, id) =>
          triage
            .get(issue)
            .send(text, { requestId: id })
            .pipe(
              Effect.andThen(record(issue)),
              // A comment on an issue that was never reported has no session.
              Effect.catchTag("NotStarted", () => Effect.void),
              Effect.orDie,
            ),
        crash: () => state.abort("crashed by a test"),
        transcript: (issue) =>
          triage
            .get(issue)
            .history({ take: 200 })
            .pipe(
              Effect.map((page) => JSON.stringify(page.items)),
              Effect.orDie,
            ),
      } satisfies Agent;
    }).pipe(Effect.provide(Cloudflare.DurableObjectCallbacks));
  }).pipe(Effect.provide(Live)),
) {}

/** The board as the Worker hosts it: its triager is the objects above. */
export const BoardLive = boardOver(BoardAgents);
