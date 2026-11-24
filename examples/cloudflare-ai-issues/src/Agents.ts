import * as AI from "@alchemy.run/ai";
import * as Boat from "@alchemy.run/boat";
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
import { Board } from "./Board/Board.model.ts";
import { BoardHandlers } from "./Board/Handlers.ts";
import type { IssueId } from "./Board/Issue.id.ts";
import { IssueSession } from "./Board/IssueSession.aggregate.ts";
import { RecordActivity } from "./Board/RecordActivity.command.ts";
import { Triager } from "./Board/Triager.external.ts";
import { SmartLlama, Smart } from "./Models.ts";
import { PostAnswerLive } from "./PostAnswer.tool.ts";
import { SandboxLive } from "./Sandbox.ts";
import { SearchIssuesLive } from "./SearchIssues.tool.ts";
import { Triage } from "./Triage.process.ts";

/** What the object of one issue answers. */
interface Agent {
  readonly start: (issue: IssueId) => Effect.Effect<void, never, RuntimeContext>;
  readonly tell: (
    issue: IssueId,
    text: string,
    id: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
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

/**
 * The harness that runs every session. To run them on OpenCode, provide
 * `OpenCode.HarnessLive`, `OpenCodeCloudflare.DurableObjectStorage` and
 * `OpenCode.CodingTools` here instead; nothing else changes.
 */
const HarnessLive = Layer.mergeAll(Pi.HarnessLive, Pi.CodingTools).pipe(
  Layer.provide(PiCloudflare.DurableObjectStorage),
);

/** Everything the Triage process mentions, and the harness it runs on. */
const Live = Layer.mergeAll(
  HarnessLive,
  AI.DefaultModel(Smart),
  SearchIssuesLive,
  PostAnswerLive,
  boardOver(own),
).pipe(
  Layer.provide(Layer.mergeAll(SmartLlama, SandboxLive)),
  Layer.provide(Boat.CreateSandboxHttp),
);

/** One Durable Object per issue: its Triage session, and what the board may ask of it. */
export default class IssueAgents extends Cloudflare.DurableObject<IssueAgents>()(
  "IssueAgents",
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
      const status = Option.getOrUndefined(yield* Stream.runHead(session.events()));
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
        // The same id however often the event is delivered, so the issue is taken up once.
        start: (issue) =>
          triage
            .get(issue)
            .send(`The issue is ${issue}.`, { requestId: "start" })
            .pipe(Effect.andThen(record(issue)), Effect.orDie),
        tell: (issue, text, id) =>
          triage
            .get(issue)
            .send(text, { requestId: id })
            .pipe(Effect.andThen(record(issue)), Effect.orDie),
      } satisfies Agent;
    }).pipe(Effect.provide(Cloudflare.DurableObjectCallbacks));
  }).pipe(Effect.provide(Live)),
) {}

/** The board as the Worker hosts it: its triager is the objects above. */
export const BoardLive = boardOver(IssueAgents);
