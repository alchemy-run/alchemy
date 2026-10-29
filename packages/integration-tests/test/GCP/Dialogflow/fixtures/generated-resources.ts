import * as GCP from "@alchemy.run/gcp";

/** Dialogflow resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeSecuritySetting = GCP.Dialogflow.SecuritySetting("ProbeSecuritySetting", {
  location: "us-central1",
  displayName: "session-only",
  retentionStrategy: "REMOVE_AFTER_CONVERSATION",
});
