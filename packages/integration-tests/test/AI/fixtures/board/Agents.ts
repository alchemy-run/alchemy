import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Fast, ModelsLive } from "../Processes.ts";
import { Board, IssueWorkLive, Triager } from "./Board.ts";
import type { IssueId } from "./Issue.id.ts";
import { Triage } from "./Triage.ts";

/** What the object of one issue answers. */
interface Agent {
  readonly start: (issue: IssueId) => Effect.Effect<void>;
  readonly tell: (issue: IssueId, text: string, id: string) => Effect.Effect<void>;
  /** What the issue's session was told and did, as its harness stores it. */
  readonly transcript: (issue: IssueId) => Effect.Effect<string>;
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
  Board.layer(IssueWorkLive).pipe(
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

    return Effect.gen(function* () {
      // The board's policy calls these from code that has no runtime context of its own.
      const runtime = yield* RuntimeContext;
      const here = Effect.provideService(RuntimeContext, runtime);
      return {
        start: (issue) => triage.start(issue, { issue }).pipe(Effect.orDie, here),
        tell: (issue, text, id) =>
          triage
            .get(issue)
            .send(text, { requestId: id })
            .pipe(
              // A comment on an issue that was never reported has no session.
              Effect.catchTag("NotStarted", () => Effect.void),
              Effect.orDie,
              here,
            ),
        transcript: (issue) =>
          triage.get(issue).messages.pipe(
            Effect.map((messages) => JSON.stringify(messages)),
            Effect.orDie,
            here,
          ),
      } satisfies Agent;
    });
  }).pipe(Effect.provide(Live)),
) {}

/** The board as the Worker hosts it: its triager is the objects above. */
export const BoardLive = boardOver(BoardAgents);
