import { describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import {
  DEFAULT_TIMEOUT_MARGIN_MS,
  readTimeoutMargin,
  toTimeoutMarginMillis,
} from "@/AWS/Lambda/InvocationDeadline.ts";

describe(
  "readTimeoutMargin",
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  () => {
    it("defaults when unset, empty or unparseable", () => {
      expect(readTimeoutMargin(undefined)).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
      expect(readTimeoutMargin("")).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
      expect(readTimeoutMargin("abc")).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
      expect(readTimeoutMargin("-1")).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
    });

    it("parses whole milliseconds, 0 included", () => {
      expect(readTimeoutMargin("0")).toBe(0);
      expect(readTimeoutMargin("250")).toBe(250);
      expect(readTimeoutMargin("250.9")).toBe(250);
    });
  },
);

describe(
  "toTimeoutMarginMillis",
  { tags: ["unit", "provider:aws", "provider:aws:lambda", "local"] },
  () => {
    it("returns undefined for undefined", () => {
      expect(toTimeoutMarginMillis(undefined)).toBeUndefined();
    });

    it("converts a Duration to whole milliseconds", () => {
      expect(toTimeoutMarginMillis(Duration.zero)).toBe(0);
      expect(toTimeoutMarginMillis(Duration.millis(250))).toBe(250);
      expect(toTimeoutMarginMillis(Duration.seconds(1))).toBe(1000);
      expect(toTimeoutMarginMillis(Duration.infinity)).toBeUndefined();
    });

    it("converts a state-JSON rehydrated Duration", () => {
      const json = JSON.parse(JSON.stringify(Duration.millis(750))) as Duration.Duration;
      expect(toTimeoutMarginMillis(json)).toBe(750);
    });
  },
);
