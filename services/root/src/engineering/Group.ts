import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Colleagues, TeammateUnknown } from "../chat/Ask.ts";
import { lineage, ROOT } from "../Lineage.ts";
import { Engineer } from "./Engineer.ts";
import { Manager } from "./Manager.ts";
import { Reviewer } from "./Reviewer.ts";

/**
 * The ENGINEERING GROUP — declared like everything else (`AI.Group`):
 * the class is the identity, the template is the roster (the splices
 * ARE the members; the FIRST is the group's head, whose session is the
 * group's channel), the Layer is completed by providing each member's
 * implementation — in ApiWorker.ts, where the members' tool layers
 * live.
 *
 * A new role = one charter file + one splice here + one provide there
 * — the exact change the company proposes (as a pull request the human
 * merges) to evolve itself.
 */
export default class Engineering extends AI.Group<Engineering>(import.meta)(
  "Engineering",
) {}

export const EngineeringChart = Engineering.make`
  The engineering group of the company. ${Manager} heads it
  (its session is this group's channel):
  it fronts the triage queue (the inbound github issues, pull requests,
  and direct requests for alchemy, distilled, and floci), files work
  as threads in the channel, and stages clean merge proposals for the
  humans.
  ${Engineer} is its worker — the coding skill-set given hands —
  staffed onto threads by the manager, one workspace each.
  ${Reviewer} is its quality gate: engineers ask it to review their
  pull requests; it iterates with them until the work meets the
  standard, then files the merge proposal the humans decide.
`;

/**
 * The COLLEAGUES seam (chat/Ask.ts), implemented for this company —
 * pure ADDRESSES (term + key; Sessions.dispatch finds the charter), so
 * this Layer holds no agent Layer and the org chart stays acyclic.
 *
 * The roster is STATIC — every agent in the channel is declared in
 * the chart (`head`, `manager`, `engineer`, `reviewer`); there are no
 * runtime identities. An agent holds MANY SESSIONS: every role
 * answers each MESSAGE in its own session
 * (`root::manager::<post-id>`, `root::engineer::<ask-post-id>`) — a
 * separate space to work in per response, starting from zero
 * (context is explored from the message graph, not carried in
 * memory) — so one identity works any number of exchanges in
 * parallel and no session accumulates the channel's history.
 */
// Layer.suspend: this module sits in the Root ↔ Group ↔ Ask import
// cycle — the tag must not be dereferenced until build time, or the
// partially-evaluated module order trips the TDZ at boot
export const ColleaguesLive: Layer.Layer<Colleagues> = Layer.suspend(() =>
  Layer.sync(Colleagues, () => {
    // the chart's STATIC refs — the members as declared, no Layer
    // dependency (Colleagues is wired into the members themselves;
    // depending on the built group would cycle)
    const members = EngineeringChart.refs
      .filter((ref): ref is typeof Manager => AI.isAgent(ref))
      .map((ref) => {
        const name = ref["~alchemy/Name"];
        return { name, slug: AI.memberSlug(name) };
      });
    const roster = ["head", ...members.map((member) => member.slug)];
    return Colleagues.of({
      resolve: (name, options) =>
        Effect.gen(function* () {
          const slug = name.trim().toLowerCase();
          // EVERY agent answers each message in its OWN session — the
          // invocation (the ask's post id) is the key. The standing
          // session (no invocation) holds only what is addressed to
          // the agent outside any message: notes, control.
          if (slug === "head") {
            return {
              name: "head",
              term: "Head",
              key:
                options?.invocation !== undefined
                  ? lineage(`head::${options.invocation}`)
                  : ROOT,
            };
          }
          const member = members.find(
            (candidate) => candidate.slug === slug,
          );
          if (member === undefined) {
            return yield* new TeammateUnknown({ member: name, roster });
          }
          const key =
            options?.invocation !== undefined
              ? lineage(`${slug}::${options.invocation}`)
              : lineage(slug);
          return { name: slug, term: member.name, key };
        }),
    });
  }),
);
