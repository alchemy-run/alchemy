import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Colleagues, TeammateUnknown } from "../chat/Ask.ts";
import { ProductChart } from "../product/Group.ts";
import { lineage, ROOT } from "../Root.ts";
import { Engineer } from "./Engineer.ts";
import { EngineeringManager } from "./Manager.ts";
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
  The engineering group of the company. ${EngineeringManager} heads it
  (its session is this group's channel):
  it fronts the triage queue (the inbound github issues, pull requests,
  and direct requests for alchemy, distilled, and floci), maintains the
  task ledger, and stages clean merge proposals for the humans.
  ${Engineer} is its worker — the coding skill-set given hands —
  staffed onto tasks by the manager, one workspace each.
  ${Reviewer} is its quality gate: engineers ask it to review their
  pull requests; it iterates with them until the work meets the
  standard, then files the merge proposal the humans decide.
`;

/**
 * The COLLEAGUES seam (chat/Ask.ts), implemented for this company —
 * pure ADDRESSES (term + key; Sessions.dispatch finds the charter), so
 * this Layer holds no agent Layer and the org chart stays acyclic:
 * `head` is the Head at the root; team roles resolve through the
 * {@link Engineering} chart at their lineage key; spawned engineers
 * (`e-…`) are Engineer sessions at theirs.
 */
// Layer.suspend: this module sits in the Root ↔ Group ↔ Ask import
// cycle — the tag must not be dereferenced until build time, or the
// partially-evaluated module order trips the TDZ at boot
export const ColleaguesLive: Layer.Layer<Colleagues> = Layer.suspend(() =>
  Layer.sync(Colleagues, () => {
    // the charts' STATIC refs — the members as declared, no Layer
    // dependency (Colleagues is wired into the members themselves;
    // depending on the built groups would cycle)
    const members = [...EngineeringChart.refs, ...ProductChart.refs]
      .filter((ref): ref is typeof EngineeringManager => AI.isAgent(ref))
      .map((ref) => {
        const name = ref["~alchemy/Name"];
        return { name, slug: AI.memberSlug(name) };
      });
    const roster = [
      "head",
      ...members.map((member) => member.slug),
      "e-<id> (a spawned engineer)",
      "r-<id> (a parallel reviewer session)",
    ];
    return Colleagues.of({
      resolve: (name) =>
        Effect.gen(function* () {
          const slug = name.trim().toLowerCase();
          if (slug === "head") {
            return { name: "head", term: "Head", key: ROOT };
          }
          if (/^e-[a-z0-9]+$/.test(slug)) {
            return {
              name: slug,
              term: Engineer["~alchemy/Name"],
              key: lineage(slug),
            };
          }
          // parallel review sessions — one reviewer TERM, a session
          // per name, so four engineers never queue on one context
          if (/^r-[a-z0-9]+$/.test(slug)) {
            return {
              name: slug,
              term: Reviewer["~alchemy/Name"],
              key: lineage(slug),
            };
          }
          const member = members.find(
            (candidate) => candidate.slug === slug,
          );
          if (member === undefined) {
            return yield* new TeammateUnknown({ member: name, roster });
          }
          return { name: slug, term: member.name, key: lineage(slug) };
        }),
    });
  }),
);
