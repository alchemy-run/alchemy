import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as S from "effect/Schema";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Parameter } from "./Parameter.ts";
import type { Services } from "./Services.ts";

type ParamOf<Refs, N> = Extract<
  Refs,
  Parameter & { readonly "~alchemy/Name": N }
>;

// per-key PRECISE: each parameter name maps to ITS schema's type (not
// the union of every parameter's type in the template), and a
// `S.optionalKey` schema makes the KEY optional — mirroring exactly
// what the compiled S.Struct does at runtime.
export type ToolParameters<Refs> = {
  [N in Extract<Refs, Parameter>["~alchemy/Name"] as ParamOf<
    Refs,
    N
  >["schema"]["~type.optionality"] extends "optional"
    ? never
    : N]: ParamOf<Refs, N>["schema"]["Type"];
} & {
  [N in Extract<Refs, Parameter>["~alchemy/Name"] as ParamOf<
    Refs,
    N
  >["schema"]["~type.optionality"] extends "optional"
    ? N
    : never]?: ParamOf<Refs, N>["schema"]["Type"];
};

/**
 * A `Tool` term is a **capability term** (with `Parameter` — design §1
 * taxonomy): never interpreted by the Kernel, it is compiled *into* its
 * host process term's turns — the template becomes the toolkit
 * description, the interpolated `Parameter` refs become the schema, and
 * the `<Self>()` tag resolves its implementation (the physics) from
 * ambient context. A tool has no inbox, no runs, and no ring.
 */
export interface Tool<
  Name extends string = string,
  Refs extends any[] = any[],
> {
  "~alchemy/Kind": "Tool";
  "~alchemy/Name": Name;
  refs: Refs;
  template: TemplateStringsArray;
  /**
   * The RETURN schema (`AI.Tool("readDiff", S.String)` — the optional
   * second argument). Direct tool-calling barely needs it (the model
   * sees results as text either way), but CODEMODE does: the generated
   * signature the model programs against is
   * `readDiff(input: {…}): Effect<string>`, and that return type comes
   * from here. Unspecified means `unknown`.
   */
  returns?: S.Top;
  params: {
    [p in keyof ToolParameters<Refs[number]>]: ToolParameters<Refs[number]>[p];
  };
  impl: (props: this["params"]) => Effect.Effect<any, any, any>;
  new (): Tool<Name, Refs>;
  /**
   * Apply the implementation — the INLINE tool form. The result is an
   * Effect so the charter's INIT `yield*`s it: that is what charges
   * the template's own splices (`${Comment}` in the description) to
   * the init's requirement channel, making the tool's dependencies a
   * type-level fact of the Layer. The yielded {@link ToolImpl} is then
   * spliced into prose; the HANDLER's requirements ride the splice
   * (they are turn-time, satisfied by the kernel at call time).
   */
  <Err = never, Req = never>(
    impl: Effect.Effect<
      (props: this["params"]) => Effect.Effect<any>,
      Err,
      Req
    >,
  ): Effect.Effect<ToolImpl<this, Err, Req>, never, Services<Refs>>;
  <Err = never, Req = never>(
    impl: (props: this["params"]) => Effect.Effect<any, Err, Req>,
  ): Effect.Effect<ToolImpl<this, Err, Req>, never, Services<Refs>>;
}

export interface ToolImpl<
  T extends Tool<any, any> = any,
  Err = any,
  Req = any,
> {
  "~alchemy/Kind": "ToolImpl";
  tool: T;
  impl: (props: T["params"]) => Effect.Effect<any, Err, Req>;
  new (): {};
}

export const Tool: {
  <Name extends string>(
    name: Name,
    returns?: S.Top,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Tool<Name, Refs>;
  };
  <Self>(): {
    <Name extends string>(
      name: Name,
      returns?: S.Top,
    ): {
      <Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Tool<Name, Refs> &
        Context.Service<
          Self,
          // the service IS the callable — a Layer whose construction
          // needs runtime context (a binding client) unwraps it inside
          // its own Layer.effect, so `yield* SomeTool` is always the
          // function, never an Effect to normalize
          (
            input: ToolParameters<Refs[number]>,
          ) => Effect.Effect<any, never, RuntimeContext>
        >;
    };
  };
} = ((name?: string, returns?: any) =>
  name
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeTool(name, template, refs, returns)
    : (name: string, returns2?: any) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeTool(name, template, refs, returns2)) as any;

// The Context.Service tag is what gives each Tool a distinct ServiceMap
// key (`alchemy/AI/Tool/{name}`) — without it every Tool resolves to the
// same (undefined) key and the last-provided handler silently serves ALL
// tools in the context. The tag is grafted on via the prototype chain
// (not `class extends`) because the term must stay CALLABLE: `Grep(impl)`
// is the ToolImpl form, and calling a class throws.
const makeTool = (
  name: string,
  template: TemplateStringsArray,
  refs: any[],
  returns?: S.Top,
) => {
  const term = function (impl: (props: any) => Effect.Effect<any, any, any>) {
    // an Effect, so init `yield*`s it — the template refs' requirements
    // are phantom on the R channel (see the Tool interface call signature)
    return Effect.succeed({ "~alchemy/Kind": "ToolImpl", tool: term, impl });
  };
  Object.setPrototypeOf(
    term,
    Context.Service<any, any>()(`alchemy/AI/Tool/${name}`),
  );
  return Object.assign(term, {
    "~alchemy/Kind": "Tool",
    "~alchemy/Name": name,
    refs,
    template,
    ...(returns !== undefined ? { returns } : {}),
  }) as any;
};

export const isTool = (value: unknown): value is Tool<any, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Tool";

/**
 * An inline tool — a `Tool` term applied to its implementation and
 * `yield*`ed in the charter's INIT
 * (`const park = yield* AI.Tool("park")`…`(() => …)`). Spliced into
 * the charter's prose, it grants the tool with its physics carried in
 * the splice: the closure form for run-local affordances (a tool that
 * flips a phase `Ref`, a persona-private verb no other term should
 * share).
 */
export const isToolImpl = (value: unknown): value is ToolImpl =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "ToolImpl";
