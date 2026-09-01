import { instanceSettingsDelta } from "@/Railway/ServiceProvider.ts";
import { describe, expect, it } from "alchemy-test";

describe("Railway Service instance settings", () => {
  it("does not update an unchanged pre-deploy command", () => {
    expect(
      instanceSettingsDelta({
        instance: { preDeployCommand: ["bun migrate"] },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: { preDeployCommand: ["bun migrate"] },
      }),
    ).toBeUndefined();
  });

  it("adds pre-deploy commands to the batched instance delta", () => {
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
          preDeployCommand: ["bun migrate", "bun seed"],
          startCommand: "bun run start",
        },
      }),
    ).toEqual({
      numReplicas: 3,
      preDeployCommand: ["bun migrate", "bun seed"],
      startCommand: "bun run start",
    });
  });

  it("clears pre-deploy commands with Railway's nullable input", () => {
    expect(
      instanceSettingsDelta({
        instance: {
          numReplicas: 2,
          preDeployCommand: ["bun migrate"],
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

  it("does not repeatedly clear an already empty command", () => {
    expect(
      instanceSettingsDelta({
        instance: { preDeployCommand: null },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: { preDeployCommand: null },
      }),
    ).toBeUndefined();
  });

  it("leaves an observed command unmanaged when the prop is omitted", () => {
    expect(
      instanceSettingsDelta({
        instance: { preDeployCommand: ["managed outside Alchemy"] },
        sourceImage: undefined,
        sourceRepo: undefined,
        registryCredentials: undefined,
        props: {},
      }),
    ).toBeUndefined();
  });
});
