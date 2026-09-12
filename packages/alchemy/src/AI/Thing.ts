import * as S from "effect/Schema";

/**
 * A `Thing` is a **vocabulary term** (with `Tool` — design §1
 * taxonomy): a named schema with prose, pure vocabulary, never
 * interpreted. AI programming is building up an ONTOLOGY of things and
 * writing expressions over them: the same `Thing` can be one tool's
 * input parameter and another tool's output field.
 *
 * Interpolated into a `Tool`'s template a thing becomes one field of
 * that tool's INPUT schema (equivalently, wrap it {@link in `AI.in`}
 * to say so explicitly); wrapped {@link out `AI.out`} it becomes one
 * field of the tool's RETURN schema instead. Its own template is the
 * field's description either way — description and schema are one
 * artifact.
 */
export type Thing<
  Name extends string = string,
  Schema extends S.Top = S.Top,
  Refs extends any[] = any[],
> = {
  "~alchemy/Kind": "Thing";
  "~alchemy/Name": Name;
  schema: Schema;
  template: TemplateStringsArray;
  refs: Refs;
};

export const Thing: {
  <const Name extends string>(
    name: Name,
  ): {
    <Schema extends S.Top>(
      schema: Schema,
    ): {
      <Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Thing<Name, Schema, Refs>;
    };
  };
  <const Name extends string, Schema extends S.Top>(
    name: Name,
    schema: Schema,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Thing<Name, Schema, Refs>;
  };
} = ((name: string, schema?: S.Top) =>
  schema
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeThing(name, schema, template, refs)
    : (schema: S.Top) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeThing(name, schema, template, refs)) as any;

const makeThing = (
  name: string,
  schema: S.Top,
  template: TemplateStringsArray,
  refs: any[],
) =>
  Object.assign(function () {}, {
    "~alchemy/Kind": "Thing",
    "~alchemy/Name": name,
    schema,
    template,
    refs,
  }) as any;

export const isThing = (value: unknown): value is Thing =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Thing";

/* ── direction markers ──────────────────────────────────────────── */

/**
 * Things spliced as OUTPUTS: `${AI.out(title, state, body)}` in a
 * tool's template renders the things' names in prose AND contributes
 * each as a field of the tool's RETURN schema — the record the
 * implementation must produce and the return type codemode's
 * generated signature declares. A tool's return type is the record of
 * its out-things; plurality lives in a thing's own schema
 * (`AI.Thing("hits", S.Array(Row))`).
 */
export interface Out<T extends Thing = Thing> {
  readonly "~alchemy/Kind": "Out";
  readonly things: ReadonlyArray<T>;
}

export const out = <const T extends ReadonlyArray<Thing<any, any, any>>>(
  ...things: T
): Out<T[number]> => ({
  "~alchemy/Kind": "Out",
  things,
});

export const isOut = (value: unknown): value is Out =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Out";

/**
 * Things spliced as INPUTS — the DEFAULT reading of a bare splice
 * (`${q}` and `${AI.in(q)}` are the same declaration), named for
 * symmetry with {@link out}: use it where a template mixes directions
 * and the bare mention would read ambiguous, or to declare several at
 * once (`${AI.in(repo, number)}`).
 */
export interface In<T extends Thing = Thing> {
  readonly "~alchemy/Kind": "In";
  readonly things: ReadonlyArray<T>;
}

const _in = <const T extends ReadonlyArray<Thing<any, any, any>>>(
  ...things: T
): In<T[number]> => ({
  "~alchemy/Kind": "In",
  things,
});
export { _in as in };

export const isIn = (value: unknown): value is In =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "In";
