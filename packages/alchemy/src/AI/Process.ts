import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Services } from "./Services.ts";

/**
 * The live handle a `Process` term interprets into — the ACTOR verbs,
 * the one contract between a kernel implementation and the
 * implementation Layers that drive delivery. Runs are keyed at
 * admission; `steer`/`settle` address them by that key.
 */
export interface ProcessService<Out = unknown, In = unknown, Err = never> {
  /**
   * Admit one work item and await its run's resolution (admit + join).
   * `options.key` names the run (see {@link ProcessService.send}).
   */
  dispatch(
    item: In,
    options?: { readonly key?: string },
  ): Effect.Effect<Out, Err, RuntimeContext>;
  /**
   * Admit one work item, fire-and-forget (the admission half alone).
   *
   * `options.key` is the run's IMPLEMENTATION-CHOSEN name — the world
   * identity the caller correlates by (`owner/repo#7`). Naming the run
   * is what makes `steer(key, …)` and `settle(key, …)` addressable
   * from outside code that never saw a kernel-minted session.
   */
  send(
    item: In,
    options?: { readonly key?: string },
  ): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Run-key–addressed input: deliver a message to a SPECIFIC run,
   * promoted at the run's next boundary (wakes a parked run for
   * another work round).
   */
  steer(
    runKey: string,
    input: unknown,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Mid-run input to the active run, promoted at the next boundary. */
  steer(input: unknown): Effect.Effect<void, never, RuntimeContext>;
  /**
   * End a SPECIFIC run from the outside: the run resolves with `event`
   * as its `Out`. The component that consumed the wire owns run
   * endings — the kernel just runs the loop. Settling a key with no
   * live run is an idempotent no-op (the run may have settled already
   * — the world outranks the org's beliefs).
   */
  settle(
    runKey: string,
    event: unknown,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Scope authority: settle in-flight work as interrupted. */
  interrupt(): Effect.Effect<void, never, RuntimeContext>;
}

/**
 * The service shape a process term's tag resolves to — REPLACE, not
 * extend: a plain term (no declared interface) is an actor
 * (`ProcessService`); an interface-bearing term is SEALED to its
 * declared interface, keeping the actor verbs internal to its
 * implementation Layer so delivery cannot be bypassed from outside.
 */
export type ProcessShape<Out, In, Err, Iface> = [Iface] extends [never]
  ? ProcessService<Out, In, Err>
  : Iface;

/**
 * A `Process` term is a charter: prose policy whose interpolations
 * declare its dependencies. Like all terms it is pure data — behavior
 * comes from interpreters (a {@link Kernel} implementation).
 *
 * The `<Self>()` form makes the process a `Context.Service` **tag**:
 * interpolating `${Fix}` in another charter contributes the tag `Fix`
 * to that charter's `Req`; yielding `Fix` in `Effect.gen` resolves the
 * live service from context. The optional second type parameter SEALS
 * the tag to a declared domain interface (see {@link ProcessShape}).
 *
 * Capability denial by omission: a charter that never interpolates
 * `${Approve}` has no `Approve` anywhere in its Layer graph's
 * requirements; no Layer can grant it merge authority. Constitutional
 * constraints are enforced by the type system, not by prose.
 *
 * The `Out`/`In`/`Err` channels are phantoms carried for the kernel
 * contract; the reset construction pins them to
 * `unknown`/`unknown`/`never` — the signature language that re-derives
 * them from refs is future work, rebuilt deliberately.
 */
export interface Process<
  Out = unknown,
  In = unknown,
  Err = never,
  Req = never,
  Name extends string = string,
  Refs extends any[] = any[],
  Self = unknown,
  Iface = never,
> {
  "~alchemy/Kind": "Process";
  "~alchemy/Name": Name;
  template: TemplateStringsArray;
  refs: Refs;
  /** Phantom channel carriers. */
  out: Out;
  input: In;
  error: Err;
  /** Phantom: the requirements of this process's implementation Layer. */
  req: Req;
  /**
   * Instances are branded with the process's name so distinct processes
   * remain distinct types (and therefore distinct tags). The instance
   * shape is the tag's resolved service: the actor verbs for a plain
   * term, the declared interface (ONLY) for an interface-bearing one.
   */
  new (
    _: never,
  ): ProcessShape<Out, In, Err, Iface> & { readonly "~alchemy/Name": Name };
  /** Phantom carrier for the tag identifier (`Self` in the `<Self>()` form). */
  "~alchemy/Self": Self;
}

export const Process: {
  // `Interface` (optional) REPLACES the tag's service shape: a plain
  // term resolves to the actor verbs (`ProcessService`); an
  // interface-bearing term is SEALED to `Interface` — the verbs stay
  // internal to its implementation Layer.
  <Self, Interface = never>(): {
    <Name extends string>(
      name: Name,
    ): {
      <const Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Process<
        unknown,
        unknown,
        never,
        Services<Refs>,
        Name,
        Refs,
        Self,
        Interface
      > &
        Context.Service<Self, ProcessShape<unknown, unknown, never, Interface>>;
    };
  };
  <Name extends string>(
    name: Name,
  ): {
    <const Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Process<unknown, unknown, never, Services<Refs>, Name, Refs>;
  };
} = ((name?: string) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeProcess(name, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeProcess(name, template, refs)) as any;

const makeProcess = (
  name: string,
  template: TemplateStringsArray | ReadonlyArray<string>,
  refs: any[],
) =>
  Object.assign(
    class extends (Context.Service<any, ProcessService<any, any, any>>()(
      `alchemy/AI/Process/${name}`,
    ) as any) {},
    {
      "~alchemy/Kind": "Process",
      "~alchemy/Name": name,
      refs,
      template,
    },
  ) as any;

export const isProcess = (
  value: unknown,
): value is Process<any, any, any, any, any, any[], any, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Process";
