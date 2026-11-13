import * as Domain from "@alchemy.run/domain";
import * as Export from "@alchemy.run/domain/Export";
import { describe, equals, it } from "@alchemy.run/test";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * Properties of Export, checked over generated inputs with `effect/Arbitrary`.
 * Each runs from a fixed seed so CI is repeatable; a failure prints its
 * shrunk input and a replay token.
 */
const property = <A>(
  name: string,
  arbitrary: Arbitrary.Arbitrary<A>,
  holds: (value: A) => boolean | Effect.Effect<boolean>,
) =>
  it.effect(
    name,
    () =>
      Arbitrary.checkEffect(arbitrary, holds, { runs: 200, seed: `export:${name}` }).pipe(
        Effect.flatMap((result) =>
          result._tag === "Passed"
            ? Effect.void
            : Effect.die(new Error(Arbitrary.formatCheckFailure(result))),
        ),
      ),
    { tags: ["unit", "local"] },
  );

// ---------------------------------------------------------------- generated event shapes

const kinds = [
  "int",
  "float",
  "string",
  "bool",
  "nullString",
  "pair",
  "ints",
  "color",
  "optionalInt",
] as const;
type Kind = (typeof kinds)[number];

const schemaOf: Record<Kind, Schema.Top> = {
  int: Schema.Int,
  float: Schema.Number,
  string: Schema.String,
  bool: Schema.Boolean,
  nullString: Schema.NullOr(Schema.String),
  pair: Schema.Struct({ a: Schema.Int, b: Schema.String }),
  ints: Schema.Array(Schema.Int),
  color: Schema.Literals(["red", "green"]),
  optionalInt: Schema.optionalKey(Schema.Int),
};

/** The columns a field of each kind must become, as `[path suffix, type, nullable]`. */
const expectedOf: Record<Kind, ReadonlyArray<readonly [string, string, boolean]>> = {
  int: [["", "Int", false]],
  float: [["", "Float", false]],
  string: [["", "String", false]],
  bool: [["", "Bool", false]],
  nullString: [["", "String", true]],
  pair: [
    [".a", "Int", false],
    [".b", "String", false],
  ],
  ints: [["", "Array", false]],
  color: [["", "Enum", false]],
  optionalInt: [["", "Int", true]],
};

/** An event's fields: unique names, each of one kind, in a generated order. */
const fieldsArbitrary = Arbitrary.schema(
  Schema.Array(
    Schema.Struct({
      name: Schema.Literals(["f0", "f1", "f2", "f3", "f4", "f5"]),
      kind: Schema.Literals(kinds),
    }),
  ),
).pipe(
  Arbitrary.map((fields) => [...new Map(fields.map((field) => [field.name, field.kind] as const))]),
);

const eventOf = (fields: ReadonlyArray<readonly [string, Kind]>) =>
  Schema.Struct({
    _tag: Schema.Literal("Generated"),
    ...Object.fromEntries(fields.map(([name, kind]) => [name, schemaOf[kind]])),
  });

const columnsOf = (fields: ReadonlyArray<readonly [string, Kind]>) => {
  const walked = Export.Spec.eventSpecOf("Generated", "Generated", eventOf(fields));
  return {
    problems: walked.problems,
    columns: walked.columns.map((c) => [c.path, c.type._tag, c.nullable] as const),
  };
};

const byPath = (rows: ReadonlyArray<readonly [string, string, boolean]>) =>
  [...rows].sort(([a], [b]) => a.localeCompare(b));

// ---------------------------------------------------------------- a table and its metadata

class Deposited extends Domain.Event("Deposited", {
  amount: Schema.Int,
  memo: Schema.NullOr(Schema.String),
}) {}
class Withdrew extends Domain.Event("Withdrew", { amount: Schema.Int }) {}
class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Deposited],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Withdrew],
}) {}
class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Deposit, Withdraw],
  decide: {
    Deposit: (_, { amount }) => [new Deposited({ amount, memo: null })],
    Withdraw: (_, { amount }) => [new Withdrew({ amount })],
  },
  evolve: { Deposited: (s) => s, Withdrew: (s) => s },
}) {}
class Ledger extends Export.Table(
  "Ledger",
  { from: [Account], key: Account, on: [Deposited, Withdrew] },
  {
    table: "ledger",
    metadata: { _export_memo: Export.Metadata.copy("event.memo", Schema.NullOr(Schema.String)) },
  },
) {}

/** Commit times within a few years of 2026, to the millisecond. */
const millis = Arbitrary.schema(Schema.Int).pipe(
  Arbitrary.map((n) => Date.parse("2026-01-01T00:00:00.000Z") + n * 997_331),
);
const delay = Arbitrary.schema(Schema.Int).pipe(Arbitrary.map((n) => Math.abs(n) * 1_009));
const iso = (at: number) => new Date(at).toISOString();

// ---------------------------------------------------------------- sealing

class Opened extends Domain.Event("Opened", {
  owner: Schema.Struct({ name: Schema.String.annotate({ sensitive: true }), age: Schema.Int }),
  limit: Schema.Int,
}) {}
class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { limit: Schema.Int },
  events: [Opened],
}) {}
class Card extends Domain.Aggregate("Card", {
  id: Schema.String,
  state: Schema.Struct({}),
  initial: {},
  commands: [Open],
  decide: { Open: (_, { limit }) => [new Opened({ owner: { name: "x", age: 1 }, limit })] },
  evolve: { Opened: (s) => s },
}) {}
class SealedCards extends Export.Table(
  "SealedCards",
  { from: [Card], key: Card, on: [Opened] },
  { table: "sealed_cards", sensitive: "encrypt" },
) {}

const testSealer = Layer.succeed(Export.Sensitive.Sealer, {
  seal: (plaintext) => Effect.succeed(`sealed:${Buffer.from(plaintext).toString("base64")}`),
  open: (ciphertext) =>
    ciphertext.startsWith("sealed:")
      ? Effect.succeed(Buffer.from(ciphertext.slice("sealed:".length), "base64").toString())
      : Effect.fail(new Export.Sensitive.SealFailed({ reason: "not sealed by this sealer" })),
});

/** Encode a row as the table writes it, add the metadata a store records, decode it as a reader does. */
const roundTrip = <
  Row extends Schema.Top & { readonly EncodingServices: unknown },
  Read extends Schema.Top & { readonly DecodingServices: unknown },
>(
  table: { readonly Row: Row; readonly Read: Read; readonly spec: Export.Spec.TableSpec },
  row: Row["Type"],
  ingestedAt: number,
) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(table.Row))(row);
    const json = encoded as Schema.JsonObject;
    const metadata = Export.Metadata.evaluate(
      table.spec.metadata,
      json,
      { ingestedAt: DateTime.makeUnsafe(ingestedAt) },
      undefined,
    );
    const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(table.Read))({
      ...json,
      ...metadata,
    });
    return { json, decoded };
  });

/**
 * The same event as storage can promise: the same class and the same JSON.
 * A store holds JSON, which has no `-0`; an event that held `-0` reads back `0`.
 */
const sameEvent = (read: object, written: object) =>
  Object.getPrototypeOf(read) === Object.getPrototypeOf(written) &&
  JSON.stringify(read) === JSON.stringify(written);

const envelopeOf = (at: number, seq: number) => ({
  id: `e-${seq}`,
  stream: "Account/a1",
  seq,
  at: DateTime.makeUnsafe(at),
  commandId: `c-${seq}`,
  correlationId: `c-${seq}`,
});

describe("Domain Export properties", { tags: ["unit", "local"] }, () => {
  // ---------------------------------------------------------------- spec derivation

  property(
    "every event field becomes the columns its type says, and nothing else",
    fieldsArbitrary,
    (fields) => {
      const { problems, columns } = columnsOf(fields);
      const expected = [
        ["event._tag", "Enum", false] as const,
        ...fields.flatMap(([name, kind]) =>
          expectedOf[kind].map(
            ([suffix, type, nullable]) => [`event.${name}${suffix}`, type, nullable] as const,
          ),
        ),
      ];
      return problems.length === 0 && equals(byPath(columns), byPath(expected));
    },
  );

  property(
    "an event's columns do not depend on the order its fields are declared in",
    fieldsArbitrary,
    (fields) =>
      equals(byPath(columnsOf(fields).columns), byPath(columnsOf([...fields].reverse()).columns)),
  );

  property(
    "a table's fingerprint does not depend on the order of its events or columns",
    Arbitrary.all([fieldsArbitrary, fieldsArbitrary]),
    ([first, second]) => {
      const event = (tag: string, fields: ReadonlyArray<readonly [string, Kind]>) => ({
        tag,
        columns: Export.Spec.eventSpecOf("T", tag, eventOf(fields)).columns,
      });
      const shape = (events: ReadonlyArray<Export.Spec.EventSpec>) => ({
        columns: Ledger.spec.columns,
        metadata: Ledger.spec.metadata,
        identity: Ledger.spec.identity,
        events,
      });
      const a = event("A", first);
      const b = event("B", second);
      return (
        Export.Spec.fingerprintOf(shape([a, b])) === Export.Spec.fingerprintOf(shape([b, a])) &&
        Export.Spec.fingerprintOf({
          ...shape([a, b]),
          columns: [...Ledger.spec.columns].reverse(),
        }) === Export.Spec.fingerprintOf(shape([a, b]))
      );
    },
  );

  // ---------------------------------------------------------------- metadata

  property(
    "lag is ingestion minus commit; a rebuild carries the first ingestion time",
    Arbitrary.all([
      millis,
      delay,
      delay,
      Arbitrary.schema(Schema.Boolean),
      Arbitrary.schema(Schema.NullOr(Schema.String)),
    ]),
    ([commit, firstDelay, rebuildDelay, rebuilt, memo]) => {
      const row = { envelope: { at: iso(commit) }, event: { memo } };
      const first = Export.Metadata.evaluate(
        Ledger.spec.metadata,
        row,
        { ingestedAt: DateTime.makeUnsafe(commit + firstDelay) },
        undefined,
      );
      const now = { ingestedAt: DateTime.makeUnsafe(commit + firstDelay + rebuildDelay) };
      const values = rebuilt
        ? Export.Metadata.evaluate(Ledger.spec.metadata, row, now, first)
        : first;
      return (
        values["_export_ingested_at"] === iso(commit + firstDelay) &&
        values["_export_lag_ms"] === firstDelay &&
        values["_export_memo"] === memo &&
        Ledger.spec.metadata.every((column) => column.path in values)
      );
    },
  );

  property(
    "a commit time that does not parse gives a null lag, not a wrong one",
    Arbitrary.schema(Schema.String),
    (at) => {
      const parses = !Number.isNaN(Date.parse(at));
      const values = Export.Metadata.evaluate(
        Ledger.spec.metadata,
        { envelope: { at } },
        { ingestedAt: DateTime.makeUnsafe(0) },
        undefined,
      );
      return parses || values["_export_lag_ms"] === null;
    },
  );

  // ---------------------------------------------------------------- rows

  property(
    "a row reads back as the event that was written, with its metadata",
    Arbitrary.all([
      Arbitrary.schema(Schema.Union([Deposited, Withdrew])),
      millis,
      delay,
      Arbitrary.schema(Schema.Int),
    ]),
    ([event, commit, wait, seq]) =>
      roundTrip(
        Ledger,
        {
          key: { id: "a1" },
          position: Math.abs(seq) + 1,
          envelope: envelopeOf(commit, Math.abs(seq) + 1),
          event,
        },
        commit + wait,
      ).pipe(
        Effect.map(
          ({ decoded }) =>
            sameEvent(decoded.event, event) &&
            decoded.key === "a1" &&
            decoded._export_lag_ms === wait &&
            decoded._export_memo === (event._tag === "Deposited" ? event.memo : null),
        ),
        Effect.orDie,
      ),
  );

  property(
    "an encrypted field is stored sealed and reads back whole",
    Arbitrary.all([Arbitrary.schema(Opened), millis]),
    ([event, commit]) =>
      roundTrip(
        SealedCards,
        { key: { id: "c1" }, position: 1, envelope: envelopeOf(commit, 1), event },
        commit,
      ).pipe(
        Effect.map(({ json, decoded }) => {
          const stored = json["event"] as Schema.JsonObject;
          return (
            typeof stored["owner"] === "string" &&
            stored["owner"].startsWith("sealed:") &&
            sameEvent(decoded.event, event)
          );
        }),
        Effect.orDie,
        Effect.provide(testSealer),
      ),
  );
});
