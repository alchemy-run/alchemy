import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
export const location = "us-central1";

export const TEST_RESOURCE_URI =
  "https://example.com/alchemy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const TEST_ATTESTATION = {
  serializedPayload: btoa("alchemy-payload"),
  signatures: [
    {
      publicKeyId: "https://example.com/keys/alchemy",
      signature: btoa("alchemy-sig"),
    },
  ],
};
