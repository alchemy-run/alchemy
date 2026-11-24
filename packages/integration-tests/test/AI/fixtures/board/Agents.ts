import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Fast, ModelsLive } from "../Processes.ts";
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
  Layer.provide(Layer.mergeAll(PiCloudflare.DurableObjectStorage, ModelsLive)),
);

/** Where an issue's Triage session runs, and what the board may ask of it. */
export default class BoardAgents extends Cloudflare.DurableObject<BoardAgents>()(
  "BoardAgents",
  Effect.gen(function* () {
    const triage = yield* Triage;
    const sessions = yield* IssueSession;
    const state = yield* Cloudflare.DurableObjectState;

    /**
     * Copy what the issue's session reports into the board, a batch at a
     * time, from the last item the board has. It ends when the object does.
     */
    const copy = Effect.fn(function* (issue: IssueId) {
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
            return sessions.send(
              new RecordActivity({
                issueId: issue,
                status: status.status,
                queued: status.queued,
                items: events.flatMap((event) =>
                  event.type === "item" ? [{ seq: event.seq, item: event.item }] : [],
                ),
              }),
            );
          }),
        );
    });

    return Effect.gen(function* () {
      let copying = false;
      /** Start copying, once for as long as this instance lives. */
      const follow = (issue: IssueId) =>
        Effect.suspend(() => {
          if (copying) return Effect.void;
          copying = true;
          return state.waitUntil(
            copy(issue).pipe(Effect.ensuring(Effect.sync(() => void (copying = false)))),
          );
        });

      // An object that wakes by itself, to carry on a turn, copies again.
      const woken = yield* state.storage.get<IssueId>("issue");
      if (woken !== undefined) yield* follow(woken);

      return {
        // Every command the session sends is sent as this labeler.
        start: (issue) =>
          triage
            .start(issue, { as: Labeler.context({ name: "triage-bot" }) })
            .pipe(
              Effect.andThen(state.storage.put("issue", issue)),
              Effect.andThen(
                triage.get(issue).send(`The issue is ${issue}.`, { requestId: "start" }),
              ),
              Effect.andThen(follow(issue)),
              Effect.orDie,
            ),
        tell: (issue, text, id) =>
          triage
            .get(issue)
            .send(text, { requestId: id })
            .pipe(
              Effect.andThen(follow(issue)),
              // A comment on an issue that was never reported has no session.
              Effect.catchTag("NotStarted", () => Effect.void),
              Effect.orDie,
            ),
        transcript: (issue) =>
          triage
            .get(issue)
            .history({ take: 200 })
            .pipe(
              Effect.map((page) => JSON.stringify(page.items)),
              Effect.orDie,
            ),
      } satisfies Agent;
    });
  }).pipe(Effect.provide(Live)),
) {}

/** The board as the Worker hosts it: its triager is the objects above. */
export const BoardLive = boardOver(BoardAgents);
