import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { type AgentService, makeTerm } from "./Agent.ts";
import type { Fragment, Services } from "./Fragment.ts";
import type { Teaching } from "./Skill.ts";
import type { Source } from "./Source.ts";

/**
 * A member could not be resolved by name — the roster (every name the
 * group declares) rides the error so a model-visible failure teaches
 * the correct address.
 */
export class MemberUnknown extends Data.TaggedError("MemberUnknown")<{
  readonly group: string;
  readonly member: string;
  readonly roster: ReadonlyArray<string>;
}> {
  override get message(): string {
    return `no member '${this.member}' in ${this.group} — the roster is: ${this.roster.join(", ")}`;
  }
}

/**
 * The service shape a group's tag resolves to. A group's service IS A
 * {@link Fragment} — the org chart, the very template `Group.make`…``
 * was made with — so splicing the group CLASS into a charter's stance
 * renders the whole chart inline (the stance compiler resolves
 * yieldable splices at render time), while contributing only the
 * GROUP's tag to the charter's requirements: the members stay
 * encapsulated behind the group's name, exactly like a skill's tools.
 */
export interface GroupService extends Fragment {
  /** The declared members: the agent's term name and its slug
   *  (`EngineeringManager` → `engineering-manager`) — the names
   *  `resolve` answers to. */
  readonly members: ReadonlyArray<{
    readonly name: string;
    readonly slug: string;
  }>;
  /** The group's HEAD — its first declared agent: the member whose
   *  session is the group's CHANNEL (the single-threaded point of
   *  view of the whole group — its management supreme). */
  readonly head: { readonly name: string; readonly slug: string };
  /** A member's actor verbs (`dispatch`/`send`/`at`…), by name or slug,
   *  case-insensitive — how a conversation reaches a member. */
  readonly resolve: (
    member: string,
  ) => Effect.Effect<AgentService<any>, MemberUnknown>;
}

/**
 * The Layer `Group.make`…`` returns: the group's tag out, the spliced
 * member AGENTS' tags in, AND the {@link Teaching} it was made from
 * (render the org chart as a document without building the Layer).
 */
export type GroupLayer<Self, Refs extends any[]> = Layer.Layer<
  Self,
  never,
  Services<Refs>
> &
  Teaching<Refs>;

/**
 * A `Group` is a STATIC, PERMANENT organizational structure — the code
 * construct threads and sessions (runtime-only things) hang from. It
 * is an ORG CHART: prose that describes a group of agents (and nested
 * groups), plus the member `AI.Agent`s themselves — packaged under one
 * NAME, as a bare `Context.Service` tag.
 *
 * Every group has, at its core, a CHANNEL: the session of its HEAD —
 * the first agent the chart splices — which provides the
 * single-threaded point of view of the whole group, its management
 * supreme. The org's root is itself a group (the Root Group): its
 * channel is the one conversation the humans hold with the company.
 * The recursion is the org — each level is a group whose head manages
 * its channel.
 *
 * The same contract/implementation split as `AI.Agent`: the class is
 * the identity, the `make` template is the roster, the member
 * implementations complete the Layer:
 *
 * ```ts
 * export default class Engineering extends AI.Group<Engineering>()("Engineering") {}
 *
 * export const EngineeringLive = Engineering.make`
 *   ${EngineeringManager} heads it; ${Engineer} is its worker,
 *   staffed onto tasks.
 * `.pipe(Layer.provide(EngineeringManagerLive), Layer.provide(GeneralEngineer));
 * ```
 *
 * Building the Layer registers every member with the driver (each
 * member's `make` Layer runs its charter interpretation), so members
 * are reachable by `Sessions`/stubs the moment the group is provided.
 * Splicing `${Engineering}` into a stance renders the chart inline
 * (see {@link GroupService}); `(yield* Engineering).resolve(name)`
 * addresses a member. A new role = one charter file + one splice +
 * one provide.
 */
export interface Group<Name extends string = string, Self = unknown> {
  "~alchemy/Kind": "Group";
  "~alchemy/Name": Name;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
  /** The defining file — present when declared as `AI.Team<Self>(import.meta)(name)`. */
  readonly source?: Source;
  /** The implementation Layer: the org chart as a tagged template
   *  whose splices are the member agent classes (and nested groups —
   *  their charts inline). */
  readonly make: <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => GroupLayer<Self, Refs>;
  new (_: never): GroupService & { readonly "~alchemy/Name": Name };
}

export const Group: {
  /**
   * `AI.Group<Self>()(name)` declares the tag; `AI.Group<Self>(import.meta)(name)`
   * additionally records the defining file as `source` (see Source.ts).
   */
  <Self>(meta?: ImportMeta): {
    <const Name extends string>(
      name: Name,
    ): Group<Name, Self> & Context.Service<Self, GroupService>;
  };
} = ((meta?: ImportMeta) => (name: string) =>
  makeTerm("Group", name, undefined, undefined, meta)) as any;

export const isGroup = (value: unknown): value is Group<string, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Group";

/** A member's addressable slug: `EngineeringManager` → `engineering-manager`. */
export const memberSlug = (name: string): string =>
  name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll(/\s+/g, "-")
    .toLowerCase();
