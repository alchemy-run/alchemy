import * as S from "effect/Schema";
import type { AST } from "effect/SchemaAST";

const Description = Symbol.for("effect/annotation/Description");

export const isTag = <T extends S.Schema<any>>(tag: T["ast"]["_tag"]) =>
  ((schema) =>
    S.isSchema(schema)
      ? S.encodedSchema(schema).ast._tag === tag
      : schema._tag === tag) as {
    (schema: S.Schema<any>): schema is T;
    (schema: AST): boolean;
  };

export const hasGenericAnnotation =
  (type: string) => (ast: AST | undefined) => {
    const description: string | undefined = ast?.annotations?.[
      Description
    ] as string;
    return (
      description &&
      description?.startsWith(`${type}<`) &&
      description?.endsWith(">")
    );
  };

export const isNullishSchema = (schema: S.Schema<any>) =>
  isNullSchema(schema) || isUndefinedSchema(schema);
export const isNullSchema = (schema: S.Schema<any>) =>
  schema.ast._tag === "Literal" && schema.ast.literal === null;
export const isUndefinedSchema = isTag("UndefinedKeyword");
export const isBooleanSchema = isTag<S.Schema<boolean>>("BooleanKeyword");
export const isStringSchema = isTag<S.Schema<string>>("StringKeyword");
export const isNumberSchema = isTag<S.Schema<number>>("NumberKeyword");

export const hasMapAnnotation = hasGenericAnnotation("Map");

export const isRecordLikeSchema = (schema: S.Schema<any>) =>
  isMapSchema(schema) ||
  isRecordSchema(schema) ||
  isStructSchema(schema) ||
  isClassSchema(schema) ||
  false;

export const isMapSchema = (schema: S.Schema<any>) =>
  hasMapAnnotation(schema.ast) ||
  // @ts-expect-error - ast.to?. is not narrowed, we don't care
  hasMapAnnotation(schema.ast.to) ||
  false;

export const isClassSchema = (schema: S.Schema<any>) => {
  const encoded = S.encodedSchema(schema);
  return (
    encoded.ast._tag === "TypeLiteral" &&
    encoded.ast.propertySignatures !== undefined
  );
};

export const isStructSchema = (schema: S.Schema<any>) => {
  return (
    schema.ast._tag === "TypeLiteral" &&
    schema.ast.propertySignatures !== undefined
  );
};

export const isRecordSchema = (schema: S.Schema<any>) => {
  const encoded = S.encodedSchema(schema);
  return (
    encoded.ast._tag === "TypeLiteral" &&
    encoded.ast.indexSignatures?.[0] !== undefined
  );
};

export const isListSchema = (schema: S.Schema<any>) => {
  return (
    hasListAnnotation(schema.ast) ||
    (S.encodedSchema(schema).ast._tag === "TupleType" && !isMapSchema(schema))
  );
};
export const hasListAnnotation = (ast: AST | undefined) => {
  const description: string | undefined = ast?.annotations?.[
    Description
  ] as string;
  return (
    description &&
    description?.startsWith("List<") &&
    description?.endsWith(">")
  );
};

export const isSetSchema = (schema: S.Schema<any>) => {
  return (
    // @ts-expect-error - ast.to?. is not narrowed, we don't care
    hasSetAnnotation(schema.ast) || hasSetAnnotation(schema.ast.to) || false
  );
};

export const hasSetAnnotation = hasGenericAnnotation("Set");

export const getSetValueAST = (schema: S.Schema<any>): AST =>
  // @ts-expect-error - ast.to?. is not narrowed, we don't care
  isSetSchema(schema) && schema.ast.to?.typeParameters[0];
