import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as Brands from "../Brands.ts";
import * as Compare from "../Compare.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, native, tagOf, wrongArguments } from "../Kit.ts";
import * as Known from "../Known.ts";
import * as Symbolic from "../Symbolic.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

/** The key the library marks a `SchemaError` with. */
const ERROR = "~effect/Schema/SchemaError";

/**
 * A schema used inside a handler: `Schema.is`, and the decodes and encodes.
 * A schema that only checks a value is read as the formula the prover has
 * for an input of it: the value passes where the formula holds. Decoding
 * gives the value back, less the fields the schema does not name. A schema
 * that changes the value it reads, or has a check the prover does not read,
 * is reported.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  const schemaOf = (v: V | undefined): unknown =>
    v?._tag === "Opaque"
      ? Known.schemas.get(v)
      : v?._tag === "Host"
        ? v.value
        : v?._tag === "Lib"
          ? Known.schemaOf(v.module, v.path)
          : undefined;

  /** The schema, when it is one the prover reads all of and that gives back the value it is given. */
  const read = (name: string, given: V | undefined, site: Site): Eval<SchemaAST.AST> => {
    const schema = schemaOf(given);
    if (!Schema.isSchema(schema)) return wrongArguments(site, name);
    const ast = schema.ast;
    if (SchemaAST.toEncoded(ast) !== ast || SchemaAST.toType(ast) !== ast)
      return Effect.fail(
        Value.notTranslated(site, `calls ${name} with a schema that changes the value it reads`),
      );
    return Symbolic.exact(ast)
      ? Effect.succeed(ast)
      : Effect.fail(
          Value.notTranslated(site, `calls ${name} with a schema the prover does not read in full`),
        );
  };

  /** Whether every part of a value is one the prover sees. */
  const visible = (value: V): boolean => {
    if (value._tag === "Opaque" || value._tag === "Applied" || value._tag === "Host") return false;
    if (value._tag === "Arr") return value.items.every(visible);
    if (value._tag === "Obj") return Object.values(value.fields).every(visible);
    return true;
  };

  /** Whether the value is one the schema allows, on this path. */
  const passes = (name: string, value: V, ast: SchemaAST.AST, site: Site): Eval<boolean> =>
    visible(value)
      ? host.decide(Compare.fromTruth(Symbolic.fits(value, ast, host.current.run)), site)
      : Effect.fail(Value.notTranslated(site, `calls ${name} on a value the prover cannot see`));

  /** What decoding gives of a value that fits: the value, less the fields the schema does not name. */
  const kept = (value: V, ast: SchemaAST.AST, site: Site): Eval<V> =>
    Effect.gen(function* () {
      const run = host.current.run;
      switch (ast._tag) {
        case "Objects": {
          if (value._tag !== "Obj" || value.brand) return value;
          const fields: Record<string, V> = {};
          for (const property of ast.propertySignatures) {
            const key = String(property.name);
            const field = value.fields[key];
            if (field === undefined) continue;
            const settled = field._tag === "Pending" ? Symbolic.resolve(field, run) : field;
            fields[key] = settled ? yield* kept(settled, property.type, site) : field;
          }
          return Value.obj(fields);
        }
        case "Arrays": {
          const member = ast.rest[0];
          const list = value._tag === "List" ? Symbolic.force(value, run) : value;
          if (list._tag !== "Arr" || !member) return value;
          const items: Array<V> = [];
          for (const item of list.items) items.push(yield* kept(item, member, site));
          return arr(items);
        }
        case "Union": {
          // The first member the value fits is the one that decodes it.
          for (const member of ast.types)
            if (yield* host.decide(Compare.fromTruth(Symbolic.fits(value, member, run)), site))
              return yield* kept(value, member, site);
          return value;
        }
        case "Declaration": {
          const parts = Symbolic.partsOf(ast);
          const option = parts._tag === "Option" ? Value.optionOf(value) : undefined;
          return parts._tag === "Option" && option?._tag === "Some"
            ? Value.some(yield* kept(option.value, parts.value, site))
            : value;
        }
        default:
          return value;
      }
    });

  const schemaError = (): V =>
    Value.obj({
      [ERROR]: Value.str(ERROR),
      _tag: Value.str("SchemaError"),
      issue: { _tag: "Opaque", what: "the issue of a SchemaError" },
    });

  const defect = (): Eval<never> =>
    Effect.fail(new Value.Rejected({ rejection: schemaError(), defect: true }));

  /** A function of a schema that gives a function of a value: `Schema.is(Ticket)(input)`. */
  const over =
    (
      name: string,
      body: (fits: boolean, value: V, ast: SchemaAST.AST, site: Site) => Eval<V>,
    ): Model =>
    ([given], site) =>
      Effect.map(read(name, given, site), (ast) =>
        native(name, ([value, options], at) =>
          // What a caller asks of the decoding, such as an error for a field too many, is not read.
          options !== undefined && options._tag !== "Undef"
            ? wrongArguments(at, name)
            : Effect.flatMap(passes(name, value ?? Value.undef, ast, at), (fits) =>
                body(fits, value ?? Value.undef, ast, at),
              ),
        ),
      );

  const success = (value: V): V => Value.obj({ _tag: Value.str("Success"), value });
  const failure = (error: V): V =>
    Value.obj({
      _tag: Value.str("Failure"),
      cause: Value.obj({ reasons: arr([Value.obj({ _tag: Value.str("Fail"), error })]) }),
    });

  const forms = (name: string): Models => ({
    [`effect/Schema:${name}Sync`]: over(`Schema.${name}Sync`, (fits, value, ast, site) =>
      fits ? kept(value, ast, site) : defect(),
    ),
    [`effect/Schema:${name}Option`]: over(`Schema.${name}Option`, (fits, value, ast, site) =>
      fits ? Effect.map(kept(value, ast, site), Value.some) : Effect.succeed(Value.none),
    ),
    [`effect/Schema:${name}Result`]: over(`Schema.${name}Result`, (fits, value, ast, site) =>
      fits
        ? Effect.map(kept(value, ast, site), Brands.success)
        : Effect.succeed(Brands.failure(schemaError())),
    ),
    [`effect/Schema:${name}Exit`]: over(`Schema.${name}Exit`, (fits, value, ast, site) =>
      fits ? Effect.map(kept(value, ast, site), success) : Effect.succeed(failure(schemaError())),
    ),
    [`effect/Schema:${name}Effect`]: over(`Schema.${name}Effect`, (fits, value, ast, site) =>
      Effect.succeed<V>({
        _tag: "Effect",
        run: fits
          ? kept(value, ast, site)
          : Effect.fail(new Value.Rejected({ rejection: schemaError() })),
      }),
    ),
  });

  const models: Models = {
    "effect/Schema:is": over("Schema.is", (fits) => Effect.succeed(Value.bool(fits))),
    // The schema and the value together: it throws where the value does not pass.
    "effect/Schema:asserts": ([given, value], site) =>
      Effect.flatMap(read("Schema.asserts", given, site), (ast) =>
        Effect.flatMap(passes("Schema.asserts", value ?? Value.undef, ast, site), (fits) =>
          fits ? Effect.succeed(Value.undef) : defect(),
        ),
      ),
    "effect/Schema:isSchemaError": ([value], site) =>
      value === undefined
        ? wrongArguments(site, "Schema.isSchemaError")
        : Effect.succeed(
            Value.bool(
              value?._tag === "Obj" &&
                tagOf(value) === "SchemaError" &&
                value.fields[ERROR] !== undefined,
            ),
          ),
    ...forms("decodeUnknown"),
    ...forms("decode"),
    ...forms("encodeUnknown"),
    ...forms("encode"),
  };

  return { models };
};
