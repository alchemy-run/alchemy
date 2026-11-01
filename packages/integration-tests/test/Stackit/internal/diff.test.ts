import { hasUnresolvedTrigger, rawProp } from "@alchemy.run/stackit/internal/diff";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

interface Props {
  serverId: string;
  region?: string;
  ipv4?: { prefix?: string };
}

const unresolved = Effect.succeed("upstream");

describe("hasUnresolvedTrigger", () => {
  it("is false when every trigger is a plain value or unset", () => {
    expect(hasUnresolvedTrigger<Props>({ serverId: "a" }, ["serverId", "region"])).toBe(false);
  });

  it("is true when a trigger is unresolved", () => {
    expect(hasUnresolvedTrigger<Props>({ serverId: unresolved }, ["serverId"])).toBe(true);
  });

  it("ignores unresolved props that are not triggers", () => {
    expect(hasUnresolvedTrigger<Props>({ serverId: "a", region: unresolved }, ["serverId"])).toBe(
      false,
    );
  });

  it("reads a nested prop, and treats a missing parent as resolved", () => {
    const news = { serverId: "a", ipv4: { prefix: unresolved } };
    expect(
      hasUnresolvedTrigger<{ prefix?: string }>(rawProp<Props>(news, "ipv4"), ["prefix"]),
    ).toBe(true);
    expect(
      hasUnresolvedTrigger<{ prefix?: string }>(rawProp<Props>({ serverId: "a" }, "ipv4"), [
        "prefix",
      ]),
    ).toBe(false);
  });
});
