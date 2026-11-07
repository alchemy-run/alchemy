import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** DLP resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeContentPolicy = GCP.DLP.ContentPolicy("ProbeContentPolicy", {
  location: "us",
  displayName: "email",
  inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
  rules: [
    {
      conditions: [
        {
          infoTypeCondition: {
            infoTypes: { infoTypeNames: ["EMAIL_ADDRESS"] },
          },
        },
      ],
      action: { returnVerdict: "BLOCK" },
    },
  ],
  defaultAction: { returnVerdict: "ALLOW" },
});
export const ProbeDlpJob = GCP.DLP.DlpJob("ProbeDlpJob", {
  inspectJob: {
    inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
    storageConfig: {
      hybridOptions: { description: "hybrid scan" },
    },
  },
});
export const ProbeLocationsStoredInfoType = GCP.DLP.LocationsStoredInfoType(
  "ProbeLocationsStoredInfoType",
  {
    location: "us-central1",
    displayName: "badge numbers",
    description: "employee badges",
    regex: { pattern: "EMP[0-9]{6}" },
  },
);
export const ProbeStoredInfoType = GCP.DLP.StoredInfoType("ProbeStoredInfoType", {
  displayName: "account ids",
  description: "internal account numbers",
  regex: { pattern: "ACCT[0-9]{8}" },
});

export const ProbeDeidentify = GCP.DLP.DeidentifyTemplate("ProbeDeidentify", {
  deidentifyConfig: {
    infoTypeTransformations: {
      transformations: [
        {
          infoTypes: [{ name: "EMAIL_ADDRESS" }],
          primitiveTransformation: { replaceWithInfoTypeConfig: {} },
        },
      ],
    },
  },
});
export const ProbeInspect = GCP.DLP.InspectTemplate("ProbeInspect", {
  inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }], includeQuote: true },
});
export const ProbeTrigger = GCP.DLP.JobTrigger("ProbeTrigger", {
  status: "PAUSED",
  inspectJob: {
    inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
    storageConfig: { hybridOptions: { description: "probe" } },
  },
  triggers: [{ manual: {} }],
});

export const ProbeLocDeidentify = GCP.DLP.LocationsDeidentifyTemplate("ProbeLocDeidentify", {
  location: "global",
  deidentifyConfig: {
    infoTypeTransformations: {
      transformations: [
        {
          infoTypes: [{ name: "EMAIL_ADDRESS" }],
          primitiveTransformation: { replaceWithInfoTypeConfig: {} },
        },
      ],
    },
  },
});
export const ProbeLocInspect = GCP.DLP.LocationsInspectTemplate("ProbeLocInspect", {
  location: "global",
  inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }], includeQuote: true },
});
export const ProbeLocTrigger = GCP.DLP.LocationsJobTrigger("ProbeLocTrigger", {
  location: "global",
  status: "PAUSED",
  inspectJob: {
    inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
    storageConfig: { hybridOptions: { description: "probe" } },
  },
  triggers: [{ manual: {} }],
});
export const ProbeLocDlpJob = GCP.DLP.LocationsDlpJob("ProbeLocDlpJob", {
  location: "global",
  inspectJob: {
    inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }], includeQuote: true },
    storageConfig: { hybridOptions: { description: "probe" } },
  },
});

/** A paused discovery config: it never profiles anything. */
export const ProbeDiscoveryConfig = Effect.gen(function* () {
  const template = yield* GCP.DLP.LocationsInspectTemplate("ProbeDiscoveryInspect", {
    location: "us",
    inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
  });
  return yield* GCP.DLP.DiscoveryConfig("ProbeDiscovery", {
    location: "us",
    displayName: "paused storage",
    status: "PAUSED",
    inspectTemplates: [template.name],
    targets: [{ cloudStorageTarget: { filter: { others: {} }, disabled: {} } }],
  });
});
