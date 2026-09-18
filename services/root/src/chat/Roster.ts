import * as AI from "alchemy/AI";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { buildOrgGraph, type OrgGraph } from "../Org.ts";
import { ROLES, type Respondent } from "./Gate.ts";

/**
 * THE ROSTER, DERIVED — who is in each room, and what each member is
 * the right first responder for, read off the ORG GRAPH instead of a
 * hand-kept list.
 *
 * The static graph registers itself when the Layers build
 * (OrgRegistry), so a group's channel membership here is exactly the
 * membership its chart declares in code: add an agent to a group's
 * `make` template and it appears in the room — and becomes routable —
 * with no second list to update. Routing RUBRICS keep the curated
 * cards where they exist (routing quality is pinned by the gate's
 * scorecard) and fall back to the head of the agent's own charter for
 * anyone the curated map has never heard of.
 */
export interface RoleCard {
  readonly what: string;
  readonly notFor?: string;
  readonly examples?: ReadonlyArray<string>;
}

const firstProse = (charter: string): string =>
  charter.replaceAll(/\s+/g, " ").trim().slice(0, 220);

/** Pure: the graph in, the rooms out. */
export const rosterFromGraph = (graph: OrgGraph) => {
  const agents = new Map(
    graph.agents.map((agent) => [agent.slug, agent] as const),
  );
  const rooms = new Map(
    graph.groups.map((group) => [
      group.name.toLowerCase(),
      group.members.map((member) => AI.memberSlug(member)),
    ]),
  );
  return {
    /** The members of a group's channel, or undefined off-graph. */
    membersOf: (channel: string): ReadonlyArray<string> | undefined =>
      rooms.get(channel),
    /** A routing rubric per member: curated where we have one, the
     *  head of the agent's own charter otherwise. */
    rolesFor: (members: ReadonlyArray<string>): Record<string, RoleCard> =>
      Object.fromEntries(
        members.map((member) => [
          member,
          (ROLES as Record<string, RoleCard>)[member] ?? {
            what: firstProse(agents.get(member)?.charter ?? member),
          },
        ]),
      ),
  };
};

export class Roster extends Context.Service<
  Roster,
  ReturnType<typeof rosterFromGraph>
>()("root/Roster") {}

/** The live roster: the same registry the org API serves. */
export const RosterLive: Layer.Layer<Roster, never, AI.OrgRegistry> =
  Layer.effect(
    Roster,
    Effect.gen(function* () {
      const registry = yield* AI.OrgRegistry;
      return Roster.of(
        rosterFromGraph(buildOrgGraph(registry.list(), new Set())),
      );
    }),
  );

export type { Respondent };
