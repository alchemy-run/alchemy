import { toTimeoutSeconds } from "@/AWS/Lambda/Function.ts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vitest";

describe("toTimeoutSeconds", () => {
  it("returns undefined for undefined", () => {
    expect(toTimeoutSeconds(undefined)).toBeUndefined();
  });

  it("decodes a Duration object", () => {
    expect(toTimeoutSeconds(Duration.seconds(30))).toBe(30);
    expect(toTimeoutSeconds(Duration.minutes(2))).toBe(120);
  });

  it("decodes a millis number", () => {
    expect(toTimeoutSeconds(30_000)).toBe(30);
  });

  it("decodes a template string", () => {
    expect(toTimeoutSeconds("45 seconds")).toBe(45);
    expect(toTimeoutSeconds("1 minute")).toBe(60);
  });

  it("decodes a [seconds, nanos] tuple", () => {
    expect(toTimeoutSeconds([15, 0])).toBe(15);
  });

  it("rounds sub-second durations up to 1", () => {
    expect(toTimeoutSeconds(Duration.millis(1))).toBe(1);
    expect(toTimeoutSeconds(Duration.millis(500))).toBe(1);
  });

  it("rounds up partial seconds", () => {
    expect(toTimeoutSeconds(Duration.millis(1500))).toBe(2);
    expect(toTimeoutSeconds(Duration.millis(2001))).toBe(3);
  });

  it("decodes a JSON-serialized Duration (Millis)", () => {
    const jsonShape = JSON.parse(JSON.stringify(Duration.seconds(42)));
    expect(jsonShape).toEqual({
      _id: "Duration",
      _tag: "Millis",
      millis: 42_000,
    });
    expect(toTimeoutSeconds(jsonShape)).toBe(42);
  });

  it("decodes a JSON-serialized Duration (Nanos)", () => {
    const jsonShape = JSON.parse(
      JSON.stringify(Duration.nanos(5_000_000_000n)),
    );
    expect(toTimeoutSeconds(jsonShape)).toBe(5);
  });

  it("returns undefined for a JSON-serialized Infinity Duration", () => {
    const jsonShape = JSON.parse(JSON.stringify(Duration.infinity));
    expect(toTimeoutSeconds(jsonShape)).toBeUndefined();
  });
});
