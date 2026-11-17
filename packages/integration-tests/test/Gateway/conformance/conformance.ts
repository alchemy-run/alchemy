import { expect } from "@alchemy.run/test";
import type { Served } from "./app.ts";
import type { AwsServed } from "./aws-app.ts";

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

/** The half that needs no network: the sandbox knows its gateway and holds no key. */
export const expectNoCredential = (
  served: Pick<Served, "apiKey" | "gateway">,
  options: { readonly gatewayHost: string },
) => {
  expect(served.gateway).toContain(options.gatewayHost);
  expect(served.apiKey ?? "").toBe("");
};

/**
 * What a gatewayed sandbox on AWS must show: its S3 bindings work through
 * the gateway's role, and its own role is refused.
 */
export const expectAwsGatewayed = (served: AwsServed) => {
  expect(served.body).toBe("written through the gateway");
  expect(served.contentLength).toBe(27);
  expect(served.direct).toBe("AccessDenied");
  expect(served.gateway).toContain(".on.aws");
};
