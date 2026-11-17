import { expect } from "@alchemy.run/test";
import type { Served } from "./app.ts";

/**
 * What every gatewayed sandbox must show: its binding answered, and the
 * credential the binding uses is not in the sandbox.
 */
export const expectGatewayed = (served: Served, options: { readonly gatewayHost: string }) => {
  // The binding answered: the gateway called E2B with the key it holds.
  expect(served.teamId).not.toBe("");
  expect(served.metrics).toBe(true);
  // The binding's own errors keep their tag across the gateway.
  expect(served.failure).not.toBe("GatewayError");
  expect(served.failure).not.toBe("none");
  // The sandbox reaches the gateway and holds no key.
  expect(served.gateway).toContain(options.gatewayHost);
  expect(served.apiKey ?? "").toBe("");
};
