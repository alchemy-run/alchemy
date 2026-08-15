import {
  isId,
  resolveZoneId,
  zoneNameCandidates,
} from "@/Cloudflare/Zone/lookup.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("Cloudflare zone lookup", () => {
  test("zoneNameCandidates walks hostname labels longest-first", () => {
    expect(zoneNameCandidates("app.example.com")).toEqual([
      "app.example.com",
      "example.com",
    ]);
    expect(zoneNameCandidates("a.b.c.example.com")).toEqual([
      "a.b.c.example.com",
      "b.c.example.com",
      "c.example.com",
      "example.com",
    ]);
    expect(zoneNameCandidates("example.com")).toEqual(["example.com"]);
  });

  test("resolveZoneId returns an explicit zone id without listing zones", () => {
    const zoneId = "0123456789abcdef0123456789abcdef";
    expect(isId(zoneId)).toBe(true);
    expect(
      Effect.runSync(
        resolveZoneId({
          accountId: "account",
          zone: zoneId,
          hostname: "app.example.com",
        }),
      ),
    ).toEqual(zoneId);
    expect(
      Effect.runSync(
        resolveZoneId({
          accountId: "account",
          zone: { zoneId, name: "example.com" },
          hostname: "app.example.com",
        }),
      ),
    ).toEqual(zoneId);
  });
});
