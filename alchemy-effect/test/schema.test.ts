import { describe, expect, test } from "bun:test";

import * as S from "effect/Schema";
import {
  getSetValueAST,
  isBooleanSchema,
  isListSchema,
  isMapSchema,
  isNullishSchema,
  isNullSchema,
  isNumberSchema,
  isRecordLikeSchema,
  isSetSchema,
  isStringSchema,
  isUndefinedSchema,
} from "../src/schema.ts";

describe("isStringSchema", () => {
  test("string", () => {
    expect(isStringSchema(S.String)).toBe(true);
  });
  test("not string", () => {
    expect(isStringSchema(S.Number)).toBe(false);
  });
});

describe("isNumberSchema", () => {
  test("number", () => {
    expect(isNumberSchema(S.Number)).toBe(true);
  });
  test("not number", () => {
    expect(isNumberSchema(S.String)).toBe(false);
  });
});

describe("isMapSchema", () => {
  test("map", () => {
    expect(
      isMapSchema(
        S.Map({
          key: S.String,
          value: S.String,
        }),
      ),
    ).toBe(true);
  });
  test("not map", () => {
    expect(
      isMapSchema(
        S.Record({
          key: S.String,
          value: S.String,
        }),
      ),
    ).toBe(false);
  });
});

describe("isRecordLikeSchema", () => {
  for (const [key, value] of Object.entries({
    map: S.Map({
      key: S.String,
      value: S.String,
    }),
    mapFromSelf: S.MapFromSelf({
      key: S.String,
      value: S.String,
    }),
    mapFromRecord: S.MapFromRecord({
      key: S.String,
      value: S.Struct({
        key: S.String,
      }),
    }),
    struct: S.Struct({
      key: S.String,
      value: S.String,
    }),
    class: class Self extends S.Class<Self>("Self")({
      key: S.String,
      value: S.String,
    }) {},
  })) {
    test(key, () => {
      expect(isRecordLikeSchema(value)).toBe(true);
    });
  }
});

describe("isListSchema", () => {
  test("list", () => {
    expect(isListSchema(S.List(S.String))).toBe(true);
  });
  test("Map type is not list", () => {
    expect(
      isListSchema(
        // Maps are built on top of tuples
        S.Map({
          key: S.String,
          value: S.String,
        }),
      ),
    ).toBe(false);
  });
});

describe("isSetSchema", () => {
  test("set", () => {
    expect(isSetSchema(S.Set(S.String))).toBe(true);
  });
  test("getSetValueAST", () => {
    expect(isStringSchema(getSetValueAST(S.Set(S.String)))).toBe(true);
  });
});

describe("isNullSchema", () => {
  test("null", () => {
    expect(isNullSchema(S.Null)).toBe(true);
  });
  test("undefined", () => {
    expect(isNullSchema(S.Undefined)).toBe(false);
  });
  test("not null", () => {
    expect(isNullSchema(S.String)).toBe(false);
  });
});

describe("isUndefinedSchema", () => {
  test("undefined", () => {
    expect(isUndefinedSchema(S.Undefined)).toBe(true);
  });
  test("not undefined", () => {
    expect(isUndefinedSchema(S.String)).toBe(false);
  });
});

describe("isNullishSchema", () => {
  test("null", () => {
    expect(isNullishSchema(S.Null)).toBe(true);
  });
  test("undefined", () => {
    expect(isNullishSchema(S.Undefined)).toBe(true);
  });
  test("not nullish", () => {
    expect(isNullishSchema(S.String)).toBe(false);
  });
});

describe("isBooleanSchema", () => {
  test("boolean", () => {
    expect(isBooleanSchema(S.Boolean)).toBe(true);
  });
  test("not boolean", () => {
    expect(isBooleanSchema(S.String)).toBe(false);
  });
});
