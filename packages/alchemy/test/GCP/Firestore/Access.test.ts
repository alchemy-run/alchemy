import { Action } from "@/Action";
import * as GCP from "@/GCP";
import {
  decodeFields,
  encodeFields,
  encodeValue,
  fieldPath,
} from "@/GCP/Firestore/Values.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const when = new Date("2026-01-02T03:04:05.678Z");
const sample = {
  str: "hello",
  int: 42,
  negative: -7,
  double: 3.5,
  big: 9007199254740993n,
  yes: true,
  no: false,
  nothing: null,
  when,
  bytes: new Uint8Array([0, 1, 254, 255]),
  list: [1, "two", false, null, { x: 3 }],
  nested: { a: { b: "deep" }, n: 1.25 },
};

/** JSON-safe view of decoded fields so Action output round-trips state. */
const describeFields = (fields: Record<string, unknown>) => ({
  str: fields.str,
  int: fields.int,
  negative: fields.negative,
  double: fields.double,
  big: typeof fields.big === "bigint" ? fields.big.toString() : fields.big,
  yes: fields.yes,
  no: fields.no,
  nothing: fields.nothing,
  when: fields.when instanceof Date ? fields.when.toISOString() : fields.when,
  bytes: fields.bytes instanceof Uint8Array ? [...fields.bytes] : fields.bytes,
  list: fields.list,
  nested: fields.nested,
});

const expectedFields = {
  str: "hello",
  int: 42,
  negative: -7,
  double: 3.5,
  big: "9007199254740993",
  yes: true,
  no: false,
  nothing: null,
  when: "2026-01-02T03:04:05.678Z",
  bytes: [0, 1, 254, 255],
  list: [1, "two", false, null, { x: 3 }],
  nested: { a: { b: "deep" }, n: 1.25 },
};

describe("Values codec", () => {
  test(
    "encodes plain JavaScript to Firestore Values",
    Effect.sync(() => {
      expect(encodeFields(sample)).toEqual({
        str: { stringValue: "hello" },
        int: { integerValue: "42" },
        negative: { integerValue: "-7" },
        double: { doubleValue: 3.5 },
        big: { integerValue: "9007199254740993" },
        yes: { booleanValue: true },
        no: { booleanValue: false },
        nothing: { nullValue: "NULL_VALUE" },
        when: { timestampValue: "2026-01-02T03:04:05.678Z" },
        bytes: { bytesValue: "AAH+/w==" },
        list: {
          arrayValue: {
            values: [
              { integerValue: "1" },
              { stringValue: "two" },
              { booleanValue: false },
              { nullValue: "NULL_VALUE" },
              { mapValue: { fields: { x: { integerValue: "3" } } } },
            ],
          },
        },
        nested: {
          mapValue: {
            fields: {
              a: { mapValue: { fields: { b: { stringValue: "deep" } } } },
              n: { doubleValue: 1.25 },
            },
          },
        },
      });
      expect(encodeFields({ skipped: undefined })).toEqual({});
      expect(encodeValue(undefined)).toEqual({ nullValue: "NULL_VALUE" });
    }),
  );

  test(
    "decodes Firestore Values to plain JavaScript",
    Effect.sync(() => {
      expect(describeFields(decodeFields(encodeFields(sample)))).toEqual(
        expectedFields,
      );
      expect(
        decodeFields({
          geo: { geoPointValue: { latitude: 1.5, longitude: -2 } },
          ref: { referenceValue: "projects/p/databases/d/documents/a/b" },
          emptyList: { arrayValue: {} },
          emptyMap: { mapValue: {} },
        }),
      ).toEqual({
        geo: { latitude: 1.5, longitude: -2 },
        ref: "projects/p/databases/d/documents/a/b",
        emptyList: [],
        emptyMap: {},
      });
    }),
  );

  test(
    "quotes non-identifier update-mask field paths",
    Effect.sync(() => {
      expect(fieldPath("plain_Name1")).toEqual("plain_Name1");
      expect(fieldPath("has space")).toEqual("`has space`");
      expect(fieldPath("a.b")).toEqual("`a.b`");
      expect(fieldPath("tick`")).toEqual("`tick\\``");
    }),
  );
});

test.provider.skipIf(!!process.env.FAST)(
  "ReadDatabase, WriteDatabase, and ReadWriteDatabase clients",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const database = yield* GCP.Firestore.Database("Access", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* database.name;
              const reader = yield* GCP.Firestore.ReadDatabase(database);
              const writer = yield* GCP.Firestore.WriteDatabase(database);
              const both = yield* GCP.Firestore.ReadWriteDatabase(database);
              return Effect.fn(function* () {
                const missing = yield* reader.get("things/typed");
                const created = yield* writer.create("things/typed", sample);
                const conflict = yield* writer
                  .create("things/typed", { str: "again" })
                  .pipe(
                    Effect.map(() => "created"),
                    Effect.catchTag(
                      "GCP.Firestore.DocumentAlreadyExists",
                      (error) => Effect.succeed(error.path),
                    ),
                  );
                const read = yield* reader.get("things/typed");

                const updated = yield* both.update("things/typed", {
                  str: "updated",
                  "odd key": 1,
                });
                const updateMissing = yield* writer
                  .update("things/never", { a: 1 })
                  .pipe(
                    Effect.map(() => "updated"),
                    Effect.catchTag("NotFound", () =>
                      Effect.succeed("NotFound"),
                    ),
                  );

                yield* both.set("scores/a", { team: "red", n: 1 });
                yield* both.set("scores/b", { team: "blue", n: 2 });
                yield* writer.set("scores/c", { team: "red", n: 3 });
                yield* writer.set("scores/c/notes/x", { text: "sub" });
                const page1 = yield* reader.list("scores", { pageSize: 2 });
                const page2 = yield* reader.list("scores", {
                  pageSize: 2,
                  pageToken: page1.nextPageToken,
                });
                const sub = yield* both.list("scores/c/notes");
                const red = yield* both.query({
                  from: [{ collectionId: "scores" }],
                  where: {
                    fieldFilter: {
                      field: { fieldPath: "team" },
                      op: "EQUAL",
                      value: { stringValue: "red" },
                    },
                  },
                });

                yield* writer.delete("scores/a");
                yield* writer.delete("scores/never-existed");
                const afterDelete = yield* both.get("scores/a");

                for (const path of [
                  "things/typed",
                  "scores/b",
                  "scores/c",
                  "scores/c/notes/x",
                ]) {
                  yield* both.delete(path);
                }

                return {
                  missing: missing === undefined,
                  createdName: created.name.endsWith("/documents/things/typed"),
                  createTime: typeof created.createTime,
                  conflict,
                  fields: read && describeFields(read.fields),
                  updated: {
                    str: updated.fields.str,
                    odd: updated.fields["odd key"],
                    int: updated.fields.int,
                  },
                  updateMissing,
                  page1: page1.documents.length,
                  hasNextPage: page1.nextPageToken !== undefined,
                  listed: [...page1.documents, ...page2.documents]
                    .map((doc) => doc.name.split("/").pop())
                    .sort(),
                  sub: sub.documents.map((doc) => doc.fields.text),
                  red: red.map((doc) => doc.fields.n).sort(),
                  afterDelete: afterDelete === undefined,
                };
              });
            }).pipe(
              Effect.provide(GCP.Firestore.ReadDatabaseHttp),
              Effect.provide(GCP.Firestore.WriteDatabaseHttp),
              Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp),
            ),
          );
          return { probe: yield* Probe({}) };
        }),
      );

      expect(out.probe).toEqual({
        missing: true,
        createdName: true,
        createTime: "string",
        conflict: "things/typed",
        fields: expectedFields,
        updated: { str: "updated", odd: 1, int: 42 },
        updateMissing: "NotFound",
        page1: 2,
        hasNextPage: true,
        listed: ["a", "b", "c"],
        sub: ["sub"],
        red: [1, 3],
        afterDelete: true,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
