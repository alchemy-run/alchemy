import { expect } from "@alchemy.run/test";
import type { Served } from "./app.ts";
import type { AwsServed } from "./aws-app.ts";

/**
 * What every gatewayed sandbox must show: its binding answered, and the
 * credential the binding uses is not in the sandbox.
 */
export const expectGatewayed = (served: Served, options: { readonly gatewayHost: string }) => {
  // The binding answered: the gateway called E2B with the key it holds.
  // An Effect member of the client (`yield* team.teamId`) ran in the gateway.
  expect(served.teamId).toMatch(/^[0-9a-f-]{36}$/);
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
 * the gateway's role, and the sandbox itself cannot call S3.
 */
export const expectAwsGatewayed = (served: AwsServed) => {
  expect(served.body).toBe("written through the gateway");
  expect(served.contentLength).toBe(27);
  // Bytes arrived whole, and streamed back.
  expect(served.streamed).toBe(1024 * 1024);
  // A presigned URL is signed by the gateway and points at S3, not at it.
  expect(served.presignedHost).toContain("amazonaws.com");
  expect(served.downloaded).toBe("written through the gateway");
  // Calling S3 as itself fails: with no credentials, or with a role that
  // was granted nothing.
  expect(served.direct).not.toBe("allowed");
  expect(served.gateway).toContain(".on.aws");
};
