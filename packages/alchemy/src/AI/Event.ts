import * as S from "effect/Schema";

/**
 * An `Event` term is a **capability term** (with `Tool` and
 * `Parameter`): pure vocabulary, never interpreted. It declares one
 * message shape the org speaks — schema and prose as ONE artifact,
 * and the class IS the payload type:
 *
 * ```ts
 * export class Mention extends AI.Event("Mention", {
 *   thread: S.String,
 *   author: S.String,
 *   text: S.String,
 * })`
 * A mention of the org in a Discord thread.` {}
 *
 * // value: the term (spliced into charters)
 * // type:  the payload — (mention: Mention) => …
 * ```
 *
 * Splicing an event into an `Agent`/`Process` charter does two things:
 *
 * - **renders** the event's description where it is mentioned, so the
 *   charter reads as a document ("A ${Mention} is a request in natural
 *   language…");
 * - **narrows the term's input alphabet**: the union of spliced event
 *   payloads (plus `string`, the always-allowed base) becomes the `In`
 *   of the {@link Actor} the term interprets into — `send`/`dispatch`/
 *   `steer` are type-checked against what the charter declares it
 *   accepts.
 *
 * It grants NOTHING else: no subscription, no bus, no delivery. How an
 * event reaches the term's Actor is entirely the implementation
 * Layer's decision (a webhook, a poll, a substrate callback) — events
 * are what may arrive, never how.
 */
export interface Event<
  Name extends string = string,
  Schema extends S.Top = S.Top,
  Refs extends any[] = any[],
> {
  "~alchemy/Kind": "Event";
  "~alchemy/Name": Name;
  schema: Schema;
  template: TemplateStringsArray;
  refs: Refs;
  /**
   * Instances ARE the payload: `Wake` the type is what one Wake
   * message is, and `new Wake({ stamp })` constructs one — the
   * payload's `_tag` is filled from the schema (never passed by the
   * caller). Purely structural beyond that: plain objects satisfy the
   * type too; `new` is a convenience, not a brand.
   */
  new (fields: Omit<Schema["Type"], "_tag">): Schema["Type"];
}

export const Event: {
  // alias another event term under this org's name and prose (the
  // payload schema — and therefore the payload TYPE — is inherited)
  <const Name extends string, Schema extends S.Top>(
    name: Name,
    event: Event<any, Schema, any[]>,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Event<Name, Schema, Refs>;
  };
  // an existing schema (e.g. a wire's event consts)
  <const Name extends string, Schema extends S.Top>(
    name: Name,
    schema: Schema,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Event<Name, Schema, Refs>;
  };
  // inline fields, built into a TAGGED struct — the event's name IS
  // the payload's `_tag`, so `Match.tag` routing works out of the box
  <const Name extends string, const Fields extends S.Struct.Fields>(
    name: Name,
    fields: Fields,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Event<Name, S.TaggedStruct<Name, Fields>, Refs>;
  };
} = ((name: string, source: object) =>
  (template: TemplateStringsArray, ...refs: any[]) => {
    const schema = isEvent(source)
      ? source.schema
      : "~effect/Schema/Schema" in source
        ? source
        : S.TaggedStruct(name, source as S.Struct.Fields);
    // the payload's tag comes from the SCHEMA (an alias keeps the
    // wire's tag, not the alias's name); untagged schemas inject none
    const tag = (
      schema as { fields?: { _tag?: { ast?: { literal?: string } } } }
    ).fields?._tag?.ast?.literal;
    return Object.assign(
      class {
        constructor(fields: object) {
          Object.assign(this, fields);
          if (tag !== undefined) {
            (this as { _tag?: string })._tag = tag;
          }
        }
      },
      {
        "~alchemy/Kind": "Event",
        "~alchemy/Name": name,
        schema,
        template,
        refs,
      },
    );
  }) as any;

export const isEvent = (value: unknown): value is Event =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Event";

/**
 * The union of event payloads spliced into a term's template — the
 * CLASS instance types (`Mentioned | Wake`), not their structural
 * expansions, so hovers stay nominal.
 */
export type Events<Refs extends any[]> = Refs[number] extends infer R
  ? R extends Event<any, any, any[]>
    ? InstanceType<R>
    : never
  : never;

/**
 * A term's input alphabet, derived from its prose: the spliced event
 * payloads plus `string` (the always-allowed base — chat and steering
 * guidance are never a type error). A charter that declares no events
 * accepts `unknown` — no events spliced means no claim made, not
 * "nothing accepted".
 */
export type Accepts<Refs extends any[]> = [Events<Refs>] extends [never]
  ? unknown
  : Events<Refs> | string;
