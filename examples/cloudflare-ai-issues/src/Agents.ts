import * as AI from "@alchemy.run/ai";
import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Pi from "@alchemy.run/pi";
import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Board } from "./Board/Board.model.ts";
import type { IssueId } from "./Board/Issue.id.ts";
import { IssueWorkLive } from "./Board/IssueWork.policy.ts";
import { Triager } from "./Board/Triager.external.ts";
import { ModelsLive, Smart } from "./Models.ts";
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
  Layer.provide(Layer.mergeAll(ModelsLive, SandboxLive)),
  Layer.provide(Boat.CreateSandboxHttp),
);

/** One Durable Object per issue: its Triage session, and what the board may ask of it. */
export default class IssueAgents extends Cloudflare.DurableObject<IssueAgents>()(
  "IssueAgents",
  Effect.gen(function* () {
    const triage = yield* Triage;

    return Effect.succeed({
      start: (issue) => triage.start(issue, { issue }).pipe(Effect.orDie),
      tell: (issue, text, id) =>
        triage
          .get(issue)
          .send(text, { requestId: id })
          .pipe(
            // A reply on an issue that was never reported here has no session.
            Effect.catchTag("NotStarted", () => Effect.void),
            Effect.orDie,
          ),
    } satisfies Agent);
  }).pipe(Effect.provide(Live)),
) {}

/** The board as the Worker hosts it: its triager is the objects above. */
export const BoardLive = boardOver(IssueAgents);
