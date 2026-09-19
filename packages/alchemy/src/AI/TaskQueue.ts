import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { isAgent } from "./Agent.ts";
import {
  dedentTemplate,
  fragment,
  type Fragment,
  type Services,
} from "./Fragment.ts";
import { memberSlug } from "./Group.ts";
import { OrgRegistry } from "./OrgRegistry.ts";
import type { Teaching } from "./Skill.ts";
import { bindSource, isSource, makeSource, type Source } from "./Source.ts";

/**
 * The service shape a task queue's tag resolves to. Like a group's, it
 * IS A {@link Fragment} — the mission prose, splices retained — so
 * splicing the queue CLASS into a charter renders the mission inline
 * while contributing only the QUEUE's tag to the charter's
 * requirements. On top of the fragment it carries the queue's
 * identity: its name, its member desks, and the desk-key derivation.
 */
export interface TaskQueueService extends Fragment {
  /** The queue's declared name (`Cloudflare`). */
  readonly name: string;
  /** The queue's addressable slug (`cloudflare`) — DO instance names,
   *  routes, and desk keys all derive from it. */
  readonly slug: string;
  /**
   * The spliced member agents, in declaration order. Position is the
   * convention (the Group's head-first law, applied to work): the
   * FIRST member is the queue's WORKER desk — it claims ready tasks —
   * and the SECOND, when declared, is its REVIEW gate.
   */
  readonly members: ReadonlyArray<{
    readonly name: string;
    readonly slug: string;
  }>;
  /** The mission prose, rendered with member slugs — what an intake
   *  router derives the queue's rubric from. */
  readonly prose: string;
  /**
   * A member's DESK — the standing, single-threaded session per
   * (queue × agent): `tasks::<queue>::<agent>`. A key FRAGMENT, not a
   * full key: hosts prefix their own root (`lineage(...)` →
   * `root::tasks::cloudflare::engineer`).
   */
  readonly deskKey: (
    member: string | { readonly "~alchemy/Name": string },
  ) => string;
}

/**
 * The Layer `Queue.make`…`` returns: the queue's tag out, the spliced
 * member AGENTS' tags in, AND the {@link Teaching} it was made from
 * (render the mission as a document without building the Layer).
 */
export type TaskQueueLayer<Self, Refs extends any[]> = Layer.Layer<
  Self,
  never,
  Services<Refs>
> &
  Teaching<Refs>;

/**
 * A `TaskQueue` is a WORK STREAM declared in code — the standing lane
 * tasks flow through, staffed by DESKS: one single-threaded session
 * per (queue × member agent) that works the stream's tasks serially,
 * forever, accumulating (and compacting) the stream's context.
 *
 * Same contract/implementation split as `AI.Group`: the class is the
 * identity, the `make` template is the mission — its splices ARE the
 * member agents — and providing each member's implementation
 * completes the Layer:
 *
 * ```ts
 * export class CloudflareTasks extends AI.TaskQueue<CloudflareTasks>(import.meta)(
 *   "Cloudflare",
 * ) {}
 *
 * export const CloudflareTasksLive = CloudflareTasks.make`
 *   Cloudflare work: provider bugs, distilled patches, live-test
 *   failures. ${Engineer} implements — one task at a time.
 *   ${Reviewer} gates every review.`;
 * ```
 *
 * The queue is identity + teaching + desk-key derivation, nothing
 * more: the board (task rows, states, events) and the desk loop are
 * the HOST's business — runtime state hangs off the code construct,
 * never the other way around. Building the Layer registers the
 * declaration in the ambient {@link OrgRegistry} (kind `TaskQueue`),
 * so rosters and the org graph see queues the same derived way they
 * see groups.
 */
export interface TaskQueue<Name extends string = string, Self = unknown> {
  "~alchemy/Kind": "TaskQueue";
  "~alchemy/Name": Name;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
  /** The defining file — present when declared as `AI.TaskQueue<Self>(import.meta)(name)`. */
  readonly source?: Source;
  /** The implementation Layer: the mission as a tagged template whose
   *  splices are the member agent classes. */
  readonly make: <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => TaskQueueLayer<Self, Refs>;
  new (_: never): TaskQueueService & { readonly "~alchemy/Name": Name };
}

export const TaskQueue: {
  /**
   * `AI.TaskQueue<Self>()(name)` declares the tag; `AI.TaskQueue<Self>(import.meta)(name)`
   * additionally records the defining file as `source` (see Source.ts).
   */
  <Self>(meta?: ImportMeta): {
    <const Name extends string>(
      name: Name,
    ): TaskQueue<Name, Self> & Context.Service<Self, TaskQueueService>;
  };
} = ((meta?: ImportMeta) => (name: string) => {
  const cls = class extends (Context.Service<any, any>()(
    `alchemy/AI/TaskQueue/${name}`,
  ) as any) {};
  return Object.assign(cls, {
    "~alchemy/Kind": "TaskQueue",
    "~alchemy/Name": name,
    ...(meta !== undefined
      ? { source: makeSource(meta, "TaskQueue", name) }
      : {}),
    make: (template: TemplateStringsArray, ...refs: any[]) =>
      taskQueueLayer(cls as any, template, refs),
  }) as any;
}) as any;

export const isTaskQueue = (value: unknown): value is TaskQueue<string, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "TaskQueue";

/** A member's desk-key fragment under one queue's slug. */
export const deskKeyOf = (queue: string, member: string): string =>
  `tasks::${queue}::${member}`;

/** The mission rendered as plain prose — agent splices as slugs. */
const renderProse = (
  template: TemplateStringsArray,
  refs: ReadonlyArray<unknown>,
): string => {
  const parts = dedentTemplate(template);
  let out = parts[0] ?? "";
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    out +=
      (isAgent(ref)
        ? memberSlug((ref as { "~alchemy/Name": string })["~alchemy/Name"])
        : isSource(ref)
          ? ((ref as Source).path ?? (ref as Source)["~alchemy/Name"])
          : String(ref)) + (parts[index + 1] ?? "");
  }
  return out.trim();
};

/** The queue Layer `make` packages — the Group Layer's shape, with
 *  identity and desk derivation in place of member actors. */
const taskQueueLayer = (
  term: TaskQueue<any, any> & Context.Service<any, any>,
  template: TemplateStringsArray,
  refs: any[],
) =>
  Object.assign(
    Layer.effect(
      term as any,
      Effect.gen(function* () {
        const queueName = term["~alchemy/Name"] as string;
        const slug = memberSlug(queueName);
        const members: Array<{ name: string; slug: string }> = [];
        for (const ref of refs) {
          if (isSource(ref)) {
            yield* bindSource(ref);
            continue;
          }
          if (!isAgent(ref)) continue;
          const name = (ref as { "~alchemy/Name": string })["~alchemy/Name"];
          members.push({ name, slug: memberSlug(name) });
        }
        if (members.length === 0) {
          return yield* Effect.die(
            `AI.TaskQueue: queue '${queueName}' declares no member agents`,
          );
        }
        // the org, DERIVED: the build that assembles the queue
        // registers its mission (OrgRegistry.ts)
        const orgRegistry = yield* Effect.serviceOption(OrgRegistry);
        if (Option.isSome(orgRegistry)) {
          orgRegistry.value.register({
            kind: "TaskQueue",
            name: queueName,
            source: (term as { source?: { path?: string } }).source?.path,
            template,
            refs,
          });
        }
        // the mission renders member NAMES as inert prose — splicing
        // a queue into a stance must not register its members as
        // delegates (the Group's rendering law)
        const teaching = yield* fragment(
          template,
          ...refs.map((ref) =>
            isAgent(ref)
              ? memberSlug(
                  (ref as { "~alchemy/Name": string })["~alchemy/Name"],
                )
              : ref,
          ),
        );
        return {
          ...teaching,
          name: queueName,
          slug,
          members,
          prose: renderProse(template, refs),
          deskKey: (member: string | { readonly "~alchemy/Name": string }) =>
            deskKeyOf(
              slug,
              memberSlug(
                typeof member === "string" ? member : member["~alchemy/Name"],
              ),
            ),
        };
      }),
    ),
    // the mission as static data on the Layer (Teaching)
    { template, refs, subject: term },
  );
