/**
 * Sensitive event fields. A field annotated `sensitive` (or holding one that
 * is) is protected as a whole top-level event field, by the table's policy:
 *
 * - `"omit"`: the field is not stored; readers get events where it is absent.
 * - `"encrypt"`: the field is stored as ciphertext, sealed by the `Sealer`
 *   service the table's Layer requires. Export never holds keys; readers
 *   with the same `Sealer` get the original value back, SQL engines see
 *   ciphertext.
 *
 * Both are Schema transformations over the event's own fields, so the writer
 * still encodes a run in one pass.
 *
 * @module
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import type * as Event from "../Event.ts";

/** A sealed value could not be opened. */
export class SealFailed extends Data.TaggedError("SealFailed")<{ readonly reason: string }> {
  override get message() {
    return `A sealed value could not be opened: ${this.reason}`;
  }
}

/**
 * Seals and opens sensitive field values, as text (the field's JSON). Bind
 * it to your key holder: a KMS, a Secret, a per-tenant key.
 */
export class Sealer extends Context.Service<
  Sealer,
  {
    readonly seal: (plaintext: string) => Effect.Effect<string>;
    readonly open: (ciphertext: string) => Effect.Effect<string, SealFailed>;
  }
>()("alchemy/Domain/Export/Sealer") {}

/** What a table does with sensitive event fields. */
export type Policy = "omit" | "encrypt";

/** A field stored as ciphertext: its JSON text, sealed. Needs the `Sealer` to encode and decode. */
export const sealed = (field: Schema.Top) =>
  Schema.String.pipe(
    Schema.decodeTo(
      field.pipe(Schema.toCodecJson, Schema.fromJsonString),
      SchemaTransformation.transformEffect<string, string, Sealer, Sealer>({
        decode: (ciphertext) =>
          Effect.flatMap(Sealer, (sealer) =>
            sealer
              .open(ciphertext)
              .pipe(
                Effect.mapError(
                  (failed) => new SchemaIssue.InvalidValue({ message: failed.message }, ciphertext),
                ),
              ),
          ),
        encode: (plaintext) => Effect.flatMap(Sealer, (sealer) => sealer.seal(plaintext)),
      }),
    ),
  );

/** The top-level fields of an event's struct, if it is one (a Domain event is a class over one). */
const structOf = (event: Schema.Top): AST.Objects | undefined => {
  const ast = AST.toType(event.ast);
  const struct =
    ast._tag === "Declaration" && ast.typeParameters.length === 1 ? ast.typeParameters[0] : ast;
  return struct?._tag === "Objects" ? struct : undefined;
};

/**
 * The Schema an event is stored with: its own fields, the protected ones
 * omitted or sealed. Without protected fields, the event itself. A sealed
 * event still decodes to its class, as the reader's type says; an omitted one
 * cannot (its class needs every field), so it decodes to its fields.
 */
export const storedEventOf = (
  event: Event.Any,
  protectedFields: ReadonlySet<string>,
  policy: Policy | undefined,
): Schema.Top => {
  const struct = structOf(event);
  if (protectedFields.size === 0 || policy === undefined || struct === undefined) return event;
  const isProtected = (property: AST.PropertySignature) =>
    protectedFields.has(String(property.name));
  if (policy === "omit") {
    return Schema.make(
      new AST.Objects(
        struct.propertySignatures.filter((property) => !isProtected(property)),
        struct.indexSignatures,
      ),
    );
  }
  const fields = Schema.make(
    new AST.Objects(
      struct.propertySignatures.map((property) =>
        isProtected(property)
          ? new AST.PropertySignature(property.name, sealed(Schema.make(property.type)).ast)
          : property,
      ),
      struct.indexSignatures,
    ),
  );
  return Schema.decodeTo(
    Schema.toType(event),
    SchemaTransformation.transform<unknown, unknown>({
      decode: (decoded) => event.make(decoded),
      // An event instance holds its fields (and `_tag`) as own properties.
      encode: (instance) => Object.assign({}, instance),
    }),
  )(fields);
};
