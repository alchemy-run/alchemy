import { listenConfig } from "@alchemy.run/effect-cluster/internal/Bootstrap";
import { GATEWAY_PORT, RUNNER_PORT } from "@alchemy.run/effect-cluster/internal/Gateway";
import { describe, expect, test } from "@alchemy.run/test";

describe("Effect Cluster runner listen config", { tags: ["provider:cluster", "unit"] }, () => {
  test("keeps today's ports and addresses when the environment sets none", () => {
    expect(listenConfig({})).toEqual({
      runnerPort: RUNNER_PORT,
      gatewayPort: GATEWAY_PORT,
      runnerListenHost: "0.0.0.0",
      gatewayListenHost: undefined,
    });
  });

  test("reads each port and listen address from the environment", () => {
    expect(
      listenConfig({
        CLUSTER_RUNNER_PORT: "4431",
        CLUSTER_GATEWAY_PORT: "4500",
        CLUSTER_LISTEN_HOST: "::",
        CLUSTER_GATEWAY_LISTEN_HOST: "127.0.0.1",
      }),
    ).toEqual({
      runnerPort: 4431,
      gatewayPort: 4500,
      runnerListenHost: "::",
      gatewayListenHost: "127.0.0.1",
    });
  });

  test("refuses a port that is not a TCP port", () => {
    expect(() => listenConfig({ CLUSTER_GATEWAY_PORT: "http" })).toThrow(/CLUSTER_GATEWAY_PORT/);
    expect(() => listenConfig({ CLUSTER_RUNNER_PORT: "70000" })).toThrow(/CLUSTER_RUNNER_PORT/);
  });
});
