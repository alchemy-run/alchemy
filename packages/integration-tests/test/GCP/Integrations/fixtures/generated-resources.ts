import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** Integrations resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeTemplate = GCP.Integrations.Template("ProbeTemplate", {
  location: "us-central1",
  displayName: "order-sync",
  description: "sync orders",
  tags: ["orders"],
  categories: ["SALES_AND_MARKETING"],
  visibility: "PRIVATE",
});

export const ProbeAuthConfig = GCP.Integrations.AuthConfig("ProbeAuthConfig", {
  location: "us-central1",
  displayName: "alchemy-probe",
  credentialType: "USERNAME_AND_PASSWORD",
  decryptedCredential: {
    credentialType: "USERNAME_AND_PASSWORD",
    usernameAndPassword: { username: "alchemy", password: "probe-secret" },
  },
  visibility: "PRIVATE",
});
export const ProbeIntegrationVersion = GCP.Integrations.IntegrationsVersion(
  "ProbeIntegrationVersion",
  {
    location: "us-central1",
    triggerConfigs: [
      {
        label: "API Trigger",
        triggerType: "API",
        triggerNumber: "1",
        triggerId: "api_trigger/alchemy_probe",
        properties: { "Trigger name": "alchemy_probe" },
      },
    ],
  },
);

export const ProbeTestCase = Effect.gen(function* () {
  const version = yield* ProbeIntegrationVersion;
  return yield* GCP.Integrations.IntegrationsVersionsTestCases("ProbeTestCase", {
    version: version.name,
    location: "us-central1",
    displayName: "happy-path",
    triggerId: "api_trigger/alchemy_probe",
  });
});

export const ProbeProductVersion = GCP.Integrations.ProductsIntegrationsVersion(
  "ProbeProductVersion",
  {
    location: "us-central1",
    product: "IP",
    description: "alchemy probe",
    triggerConfigs: [
      {
        label: "API Trigger",
        triggerType: "API",
        triggerNumber: "1",
        triggerId: "api_trigger/alchemy_probe_product",
        properties: { "Trigger name": "alchemy_probe_product" },
      },
    ],
  },
);
