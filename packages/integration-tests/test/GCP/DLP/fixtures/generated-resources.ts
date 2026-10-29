import * as GCP from "@alchemy.run/gcp";

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
