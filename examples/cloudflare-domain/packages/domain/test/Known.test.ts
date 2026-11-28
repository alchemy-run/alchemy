import * as Brands from "@alchemy.run/domain/Prove/internal/Brands";
import * as Known from "@alchemy.run/domain/Prove/internal/Known";
import * as Value from "@alchemy.run/domain/Prove/internal/Value";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

// Values the library gives, as the prover holds them, and the other way:
// what each kind turns into where no table reaches it.

const held: Value.V = { _tag: "Term", term: { sort: "Int", text: "n" } };
const brandOf = (v: Value.V): Value.Brand | undefined =>
  (v as { readonly brand?: Value.Brand }).brand;

it("what the prover cannot see into is not a value it knows", () => {
  expect(Known.known(Redacted.make(1), "secret")).toBeUndefined();
  expect(Known.known([Effect.void], "effects")).toBeUndefined();
  expect(Known.known({ run: Effect.void }, "effects")).toBeUndefined();
  expect(Known.known(HashSet.make(Effect.void), "effects")).toBeUndefined();
  // A duration with no end, and a time in a zone, are passed along as the library made them.
  expect(Known.known(Duration.infinity, "forever")?._tag).toBe("Host");
  expect(
    Known.known(DateTime.makeZonedUnsafe(0, { timeZone: "Europe/Paris" }), "there")?._tag,
  ).toBe("Host");
});

it("a time before 1970 is a negative count, read back as one", () => {
  const before = Known.known(DateTime.makeUnsafe(-1000), "before")!;
  expect(before).toEqual({ _tag: "Time", millis: { sort: "Int", text: "(- 1000)" } });
  const real = Known.real(before)!.value as DateTime.Utc;
  expect(DateTime.toEpochMillis(real)).toBe(-1000);
});

it("a value with a part an input holds has no real value", () => {
  const option = brandOf(Value.some(Value.undef));
  expect(Known.real(Value.obj({ _tag: Value.str("None") }, option))).toEqual({
    value: Option.none(),
  });
  expect(Known.real(Value.some(held))).toBeUndefined();
  expect(Known.real(Brands.failure(Value.num(2)))).toEqual({ value: Result.fail(2) });
  expect(Known.real(Brands.success(held))).toBeUndefined();
  expect(Known.real(Value.obj({}, brandOf(Brands.duration(Value.num(1)))))).toBeUndefined();
  expect(Known.real(Brands.hashSet(held))).toBeUndefined();
  expect(Known.real(Brands.hashMap(held))).toBeUndefined();
  expect(
    Known.real(Value.obj({}, { kind: "Data", cls: 5 } as unknown as Value.Brand)),
  ).toBeUndefined();
  expect(
    Known.real(Value.obj({ x: held }, { kind: "Data", cls: class {} } as unknown as Value.Brand)),
  ).toBeUndefined();
  // Something only the prover has, and a function it does not know the real one of.
  expect(Known.real({ _tag: "Opaque", what: "a thing" })).toBeUndefined();
  expect(
    Known.real({ _tag: "Lib", module: "effect/Nothing", path: [] } as Value.V),
  ).toBeUndefined();
});

it("a name looked up past a value that is not a module's is not there", () => {
  expect(Known.hostOf("effect/Number", ["sum", "length", "toFixed", "x"])).toBeUndefined();
  expect(Known.schemaOf("effect/Number", [])).toBeUndefined();
  expect(Known.schemaOf("effect/Schema", ["Number", "nothing", "here"])).toBeUndefined();
});

it("a value the prover knows all of is the real one", () => {
  const fn = Known.known((n: number) => n + 1, "next")!;
  expect(typeof Known.real(fn)?.value).toBe("function");
  expect(Known.real(Value.some(Value.num(1)))).toEqual({ value: Option.some(1) });
  expect(Known.real(Brands.success(Value.num(1)))).toEqual({ value: Result.succeed(1) });
  const redacted = { kind: "Redacted" } as unknown as Value.Brand;
  expect(
    Redacted.value(
      Known.real(Value.obj({ value: Value.num(1) }, redacted))!.value as Redacted.Redacted<number>,
    ),
  ).toBe(1);
  expect(Known.real(Value.obj({ value: held }, redacted))).toBeUndefined();
  expect(
    HashSet.size(
      Known.real(Brands.hashSet({ _tag: "Arr", items: [Value.num(1)] }))!
        .value as HashSet.HashSet<number>,
    ),
  ).toBe(1);
  const entries: Value.V = {
    _tag: "Arr",
    items: [{ _tag: "Arr", items: [Value.str("k"), Value.num(2)] }],
  };
  expect(
    HashMap.get(Known.real(Brands.hashMap(entries))!.value as HashMap.HashMap<string, number>, "k"),
  ).toEqual(Option.some(2));
});
