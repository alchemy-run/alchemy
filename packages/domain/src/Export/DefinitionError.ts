import * as Data from "effect/Data";

// ---------------------------------------------------------------- definitions

/** A field's Schema has no column type: a function, `unknown`, `any`, `never` or a symbol. */
export class UnsupportedType extends Data.TaggedError("UnsupportedType")<{
  readonly table: string;
  /** The field's dotted path, e.g. `event.lines[].sku`. */
  readonly path: string;
  /** The AST node's tag, e.g. `Unknown`. */
  readonly kind: string;
}> {
  override get message() {
    return `Table '${this.table}' cannot store '${this.path}': a ${this.kind} has no column type`;
  }
}

/** A field annotated `sensitive` in a table that does not say what to do with it. */
export class UnprotectedSensitive extends Data.TaggedError("UnprotectedSensitive")<{
  readonly table: string;
  readonly path: string;
}> {
  override get message() {
    return `Table '${this.table}' exports the sensitive field '${this.path}' without a 'sensitive' policy ("omit" or "encrypt")`;
  }
}

/** Two tables of one store share a physical name. */
export class DuplicateTableName extends Data.TaggedError("DuplicateTableName")<{
  readonly store: string;
  /** The physical name the tables share. */
  readonly physical: string;
  readonly tables: ReadonlyArray<string>;
}> {
  override get message() {
    return `Store '${this.store}' would hold ${this.tables.join(" and ")} under one name, '${this.physical}'`;
  }
}

/** An engine is asked about a table none of its stores holds. */
export class TableNotInEngine extends Data.TaggedError("TableNotInEngine")<{
  readonly engine: string;
  readonly table: string;
}> {
  override get message() {
    return `Engine '${this.engine}' does not read a store holding table '${this.table}'`;
  }
}

/** An engine's Layer binds an implementation that speaks another dialect than the engine declares. */
export class DialectMismatch extends Data.TaggedError("DialectMismatch")<{
  readonly engine: string;
  readonly declared: string;
  readonly bound: string;
}> {
  override get message() {
    return `Engine '${this.engine}' declares dialect '${this.declared}' but its Layer binds a '${this.bound}' engine`;
  }
}

/** A metadata field does not say how it is computed: build it with `Export.Metadata`. */
export class MetadataWithoutValue extends Data.TaggedError("MetadataWithoutValue")<{
  readonly table: string;
  readonly path: string;
}> {
  override get message() {
    return `Table '${this.table}' declares metadata '${this.path}' without saying how it is computed; build it with Export.Metadata`;
  }
}

/** A table's metadata redefines one every table has. */
export class MetadataRedefined extends Data.TaggedError("MetadataRedefined")<{
  readonly table: string;
  readonly path: string;
}> {
  override get message() {
    return `Table '${this.table}' redefines the metadata '${this.path}' every table has`;
  }
}

/** Every problem a definition check reports. */
export type Reason =
  | UnsupportedType
  | UnprotectedSensitive
  | DuplicateTableName
  | TableNotInEngine
  | MetadataWithoutValue
  | MetadataRedefined
  | DialectMismatch;

/** What a definition check dies with: the first problem found. */
export class DefinitionError extends Data.TaggedError("ExportDefinitionError")<{
  readonly reason: Reason;
}> {
  override get message() {
    return this.reason.message;
  }
}
