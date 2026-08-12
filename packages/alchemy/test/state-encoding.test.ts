import { deepEqual } from "@/Diff";
import {
  DATE_MARKER,
  encodeState,
  reviveState,
  reviveStateRecursive,
} from "@/State/StateEncoding";
import { describe, expect, test } from "alchemy-test";

// Dates in persisted props must ROUND-TRIP: a provider's `diff`/`delete`/
// `read` receive `olds` from the state store on a later run, and a
// Date-typed prop must come back as a real Date — not `{}` (the old
// structural-walk bug, which churned a phantom update on every plan) and
// not a bare ISO string (which lies about the declared prop type).
describe("StateEncoding Date round-trip", () => {
  const value = {
    expires: new Date("2027-01-01T00:00:00.000Z"),
    nested: { dates: [new Date("2028-06-15T12:30:00.000Z")] },
    text: "unrelated",
  };

  test("encode → JSON → reviveState rebuilds Date instances (local store path)", () => {
    const revived = JSON.parse(
      JSON.stringify(encodeState(value)),
      reviveState,
    ) as typeof value;
    expect(revived.expires).toBeInstanceOf(Date);
    expect(revived.expires.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(revived.nested.dates[0]).toBeInstanceOf(Date);
    expect(revived.nested.dates[0]!.toISOString()).toBe(
      "2028-06-15T12:30:00.000Z",
    );
    expect(revived.text).toBe("unrelated");
  });

  test("encode → transport JSON → reviveStateRecursive rebuilds Date instances (HTTP store path)", () => {
    // The HTTP state store sends `encodeState(...)` as a JSON payload and
    // revives the pre-parsed value on the way back out.
    const transported = JSON.parse(JSON.stringify(encodeState(value)));
    const revived = reviveStateRecursive(transported) as typeof value;
    expect(revived.expires).toBeInstanceOf(Date);
    expect(revived.expires.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(revived.nested.dates[0]).toBeInstanceOf(Date);
  });

  test("the persisted envelope is the marker, not a structural walk", () => {
    expect(encodeState(new Date("2027-01-01T00:00:00.000Z"))).toEqual({
      [DATE_MARKER]: "2027-01-01T00:00:00.000Z",
    });
  });

  test("legacy rows with bare ISO strings stay strings and never churn", () => {
    // Rows written before DATE_MARKER persisted plain ISO strings. The
    // reviver must not promote arbitrary strings to Dates — and the diff
    // must still treat them as equal to the program's live Date, so legacy
    // rows re-deploy without a phantom update.
    const legacy = JSON.parse(
      JSON.stringify({ expires: "2027-01-01T00:00:00.000Z" }),
      reviveState,
    ) as { expires: unknown };
    expect(typeof legacy.expires).toBe("string");
    expect(
      deepEqual(
        { expires: new Date("2027-01-01T00:00:00.000Z") },
        { expires: "2027-01-01T00:00:00.000Z" },
      ),
    ).toBe(true);
  });

  test("a user object that happens to carry the marker key is not corrupted into a Date", () => {
    // Both revivers only rewrite EXACT single-key envelopes, so a user prop
    // shaped `{ __date__: ..., other: ... }` survives untouched through the
    // HTTP path and the local JSON.parse path alike.
    const suspicious = { [DATE_MARKER]: "2027-01-01T00:00:00.000Z", n: 1 };
    const viaHttp = reviveStateRecursive(
      JSON.parse(JSON.stringify(suspicious)),
    ) as typeof suspicious;
    expect(viaHttp.n).toBe(1);
    expect(typeof viaHttp[DATE_MARKER]).toBe("string");
    const viaLocal = JSON.parse(
      JSON.stringify(suspicious),
      reviveState,
    ) as typeof suspicious;
    expect(viaLocal.n).toBe(1);
    expect(typeof viaLocal[DATE_MARKER]).toBe("string");
  });
});
