/**
 * Worker `env` strings that `JSON.parse` would turn into something else.
 * Each must read back unchanged through `Config.String`, during Init and at
 * request time, and through the raw `env` (#2269, #2847, #3497).
 */
export const jsonStrings = {
  JSON_FALSE: "false",
  JSON_TRUE: "true",
  JSON_NUM: "42",
  JSON_ZERO: "0",
  JSON_NEG_ZERO: "-0",
  JSON_DECIMAL: "1.0",
  JSON_EXPONENT: "1e3",
  JSON_LONG_DECIMAL: "12345678901.12345678901234",
  JSON_BIG_INT: "9007199254740993",
  JSON_NULL: "null",
  JSON_QUOTED: '"quoted"',
  JSON_OBJ: '{"a":1}',
  JSON_OBJ_SPACED: '{ "a": 1 }',
  JSON_ARR: "[1, 2]",
  PLAIN: "my-queue",
} as const;

export type JsonStringKey = keyof typeof jsonStrings;
