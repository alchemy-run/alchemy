import { describe, expect, it } from "alchemy-test";
import { limitsPatch, serviceLimits } from "@/Railway/ServiceLimits.ts";

describe("Railway service resource limits", () => {
  it("reads deploy.limitOverride.containers", () => {
    expect(
      serviceLimits(
        {
          services: {
            api: {
              deploy: { limitOverride: { containers: { cpu: 1, memoryBytes: 4_000_000_000 } } },
            },
          },
        },
        "api",
      ),
    ).toEqual({ cpu: 1, memoryBytes: 4_000_000_000 });
  });

  it("reports no limits when the override is absent", () => {
    expect(serviceLimits({ services: { api: { deploy: {} } } }, "api")).toBeUndefined();
    expect(
      serviceLimits({ services: { api: { deploy: { limitOverride: null } } } }, "api"),
    ).toBeUndefined();
    expect(serviceLimits({}, "api")).toBeUndefined();
  });

  it("patches only the fields that differ", () => {
    expect(
      limitsPatch({ cpu: 2, memoryBytes: 4_000_000_000 }, { cpu: 1, memoryBytes: 4_000_000_000 }),
    ).toEqual({
      containers: { cpu: 2 },
    });
    expect(limitsPatch({ memoryBytes: 2_000_000_000 }, undefined)).toEqual({
      containers: { memoryBytes: 2_000_000_000 },
    });
  });

  it("leaves matching limits alone and keeps omitted fields", () => {
    expect(limitsPatch({ cpu: 1 }, { cpu: 1, memoryBytes: 4_000_000_000 })).toBeUndefined();
  });
});
