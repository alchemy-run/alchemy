import * as GCP from "@alchemy.run/gcp";

/** AgentIdentity resources the generated bindings bind, mirroring each resource suite's smallest shape. */
export const ProbeAuthProvider = GCP.AgentIdentity.AuthProvider("ProbeAuthProvider", {
  location: "us-central1",
  allowedScopes: ["https://www.googleapis.com/auth/cloud-platform"],
  authProviderTypeParams: { apiKey: { apiKey: "alchemy-probe-api-key" } },
});
