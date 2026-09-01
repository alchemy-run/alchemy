import {
  instanceSettingsDelta,
  normalizePreDeployCommand,
} from "@/Railway/ServiceProvider.ts";
import { describe, expect, it } from "alchemy-test";

describe("Railway Service instance settings", () => {
  it("normalizes Railway's scalar and singleton-list responses", () => {
    expect(normalizePreDeployCommand("bun migrate")).toBe("bun migrate");
    expect(normalizePreDeployCommand(["bun migrate"])).toBe("bun migrate");
  });

  it("normalizes null and empty-list responses to no command", () => {
    expect(normalizePreDeployCommand(null)).toBeUndefined();
    expect(normalizePreDeployCommand([])).toBeUndefined();
  });

  it("does not update an unchanged scalar response", () => {
    expect(
      instanceSettingsDelta({
        instance: { preDeployCommand: "bun migrate" },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: { preDeployCommand: "bun migrate" },
      }),
    ).toBeUndefined();
  });

  it("does not update an unchanged singleton-list response", () => {
    expect(
      instanceSettingsDelta({
        instance: { preDeployCommand: ["bun migrate"] },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: { preDeployCommand: "bun migrate" },
      }),
    ).toBeUndefined();
  });

  it("sets one command in the batched service-instance delta", () => {
    expect(
      instanceSettingsDelta({
        instance: {
          numReplicas: 3,
          preDeployCommand: ["bun migrate"],
          startCommand: "bun start",
        },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: {
          preDeployCommand: "bun run migrate",
          startCommand: "bun run start",
        },
      }),
    ).toEqual({
      numReplicas: 3,
      preDeployCommand: ["bun run migrate"],
      startCommand: "bun run start",
    });
  });

  it("clears an observed command with Railway's nullable input", () => {
    expect(
      instanceSettingsDelta({
        instance: {
          numReplicas: 2,
          preDeployCommand: "bun migrate",
        },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: { preDeployCommand: null },
      }),
    ).toEqual({
      numReplicas: 2,
      preDeployCommand: null,
    });
  });

  it("does not repeatedly clear null or empty-list responses", () => {
    for (const preDeployCommand of [null, []]) {
      expect(
        instanceSettingsDelta({
          instance: { preDeployCommand },
          sourceImage: undefined,
          sourceRepo: undefined,
          registryCredentials: undefined,
          props: { preDeployCommand: null },
        }),
      ).toBeUndefined();
    }
  });

  it("leaves an observed command unmanaged when the prop is omitted", () => {
    expect(
      instanceSettingsDelta({
        instance: { preDeployCommand: "managed outside Alchemy" },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: {},
      }),
    ).toBeUndefined();
  });
});
