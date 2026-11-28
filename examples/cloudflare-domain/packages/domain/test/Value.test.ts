import * as Value from "@alchemy.run/domain/Prove/internal/Value";
import { expect, it } from "@effect/vitest";

// The prover's values, on their own: what they do where no table reaches them.

it("every kind of value has a key, the same for the same value", () => {
  const keys = [
    { _tag: "Big", value: 3n },
    Value.bool(true),
    Value.nil,
    Value.undef,
    { _tag: "Term", term: { sort: "Int", text: "n" }, big: true },
    { _tag: "Term", term: { sort: "Int", text: "n" } },
    { _tag: "List", name: "items", ast: undefined },
    { _tag: "Pending", name: "field" },
    { _tag: "Applied", key: "f(1)" },
    { _tag: "Opaque", what: "a thing" },
  ].map((v) => Value.keyOf(v as Value.V));
  expect(new Set(keys).size).toBe(keys.length);
  expect(Value.keyOf({ _tag: "Big", value: 3n })).toBe(keys[0]);
});

it("an option made with no value holds undefined", () => {
  const brand = (Value.some(Value.undef) as { readonly brand?: Value.Brand }).brand;
  const made = Value.obj({ _tag: Value.str("Some") }, brand);
  expect(Value.optionOf(made)).toEqual({ _tag: "Some", value: Value.undef });
});

it("a condition known true or false is taken without a choice", () => {
  const run = new Value.Run([]);
  expect(run.branch("true")).toBe(true);
  expect(run.branch("false")).toBe(false);
  expect(run.taken).toEqual([]);
});
