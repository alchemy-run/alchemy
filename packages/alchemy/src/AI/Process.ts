import type * as Context from "effect/Context";
import { makeTerm } from "./Agent.ts";
import type { Services } from "./Services.ts";

/**
 * A `Process` term is prose describing a BUSINESS PROCESS — how work
 * moves from arrival to done — referencing the {@link Agent}s that do
 * its work and the tools the process itself wields. Like an Agent it
 * is pure data: a tagged template plus refs, interpreted by a
 * {@link Kernel}.
 *
 * What makes it a Process and not an Agent is its public surface.
 * Where every agent's tag resolves to the one generic
 * {@link Actor} (agents exist to be called), a Process's tag
 * resolves to its declared `Shape` — a deterministic, domain-specific
 * interface — and NOTHING else. No one can talk to a Process:
 *
 * - There is no kernel-default Layer (`AI.layer` rejects Process
 *   terms). A Process is executed only by its hand-written
 *   implementation Layer — `Layer.effect(Issues, …)` — which
 *   interprets the charter via `Kernel.interpret` and holds the
 *   resulting verbs PRIVATELY in its closure.
 * - The Layer decides how the world drives the run loop: an event
 *   subscription (`IssueOpened` ⇒ `send`, `IssueCommented` ⇒ `steer`,
 *   `IssueClosed` ⇒ `settle`), a schedule, a substrate callback — and
 *   exposes only the deliberate seams as `Shape` methods.
 * - Consumers — deterministic code and other charters alike — get
 *   exactly `Shape` when the tag resolves. Bypass is impossible by
 *   construction: the verbs are unreachable outside the Layer.
 *
 * ```ts
 * export interface IssuesService {
 *   readonly list: () => Effect.Effect<Issue[], ApiError>;
 * }
 *
 * export class Issues extends AI.Process<Issues, IssuesService>()("Issues")`
 * This process manages GitHub issues for ${repo} from open to close. …
 * A ready issue is handed to ${Engineer}. …` {}
 *
 * export const IssuesLive = Layer.effect(Issues, Effect.gen(function* () {
 *   const issues = yield* AI.interpret(Issues);      // the loop, private
 *   yield* GitHub.consumeRepositoryEvents(repo, …);  // the world drives
 *   return { list: … };                              // the Shape, public
 * }));
 * ```
 */
export interface Process<
  Shape = unknown,
  Req = never,
  Name extends string = string,
  Refs extends any[] = any[],
  Self = unknown,
> {
  "~alchemy/Kind": "Process";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;
  refs: Refs;
  /** Phantom: the requirements of this process's implementation Layer. */
  "~alchemy/Req": Req;
  /** Phantom carrier for the tag identifier (`Self` in the `<Self, Shape>()` form). */
  "~alchemy/Self": Self;
  /**
   * Instances are branded with the process's name so distinct
   * processes remain distinct types (and therefore distinct tags).
   * The instance shape is the declared interface ONLY — the actor
   * verbs never appear on a Process's tag.
   */
  new (_: never): Shape & { readonly "~alchemy/Name": Name };
}

export const Process: {
  // Shape is REQUIRED: a Process without a deterministic interface is
  // an Agent — declare it as one.
  <Self, Shape>(): {
    <Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Process<Shape, Services<Refs>, Name, Refs, Self> &
        Context.Service<Self, Shape>;
    };
  };
} = (() =>
  (name: string) =>
  (template: TemplateStringsArray, ...refs: any[]) =>
    makeTerm("Process", name, template, refs)) as any;

export const isProcess = (
  value: unknown,
): value is Process<any, any, any, any[], any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Process";
