import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** Healthcare resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDataset = GCP.Healthcare.Dataset("ProbeDataset", {
  location: "us-central1",
  timeZone: "America/New_York",
});

export const ProbeConsentStore = Effect.gen(function* () {
  const dataset = yield* ProbeDataset;
  return yield* GCP.Healthcare.DatasetsConsentStore("ProbeConsents", { dataset: dataset.name });
});
export const ProbeDicomStore = Effect.gen(function* () {
  const dataset = yield* ProbeDataset;
  return yield* GCP.Healthcare.DatasetsDicomStore("ProbeDicom", { dataset: dataset.name });
});
export const ProbeFhirStore = Effect.gen(function* () {
  const dataset = yield* ProbeDataset;
  return yield* GCP.Healthcare.DatasetsFhirStore("ProbeFhir", {
    dataset: dataset.name,
    version: "R4",
  });
});
export const ProbeHl7V2Store = Effect.gen(function* () {
  const dataset = yield* ProbeDataset;
  return yield* GCP.Healthcare.DatasetsHl7V2Store("ProbeHl7", { dataset: dataset.name });
});
export const ProbeHl7Message = Effect.gen(function* () {
  const store = yield* ProbeHl7V2Store;
  return yield* GCP.Healthcare.DatasetsHl7V2StoresMessage("ProbeAdt", {
    parent: store.name,
    data: [
      "MSH|^~\\&|ALCHEMY|TESTFAC|RECEIVER|RECVFAC|20240101120000||ADT^A01|MSG00001|P|2.5",
      "PID|1||PAT001^^^MR||DOE^JOHN",
    ].join("\r"),
  });
});
export const ProbeAttribute = Effect.gen(function* () {
  const store = yield* ProbeConsentStore;
  return yield* GCP.Healthcare.DatasetsConsentStoresAttributeDefinition("ProbeDataType", {
    consentStore: store.name,
    category: "RESOURCE",
    allowedValues: ["fhir", "dicom"],
  });
});
export const ProbeArtifact = Effect.gen(function* () {
  const store = yield* ProbeConsentStore;
  return yield* GCP.Healthcare.DatasetsConsentStoresConsentArtifact("ProbeProof", {
    consentStore: store.name,
    userId: "user-123",
    consentContentVersion: "v1",
  });
});
export const ProbeConsent = Effect.gen(function* () {
  const store = yield* ProbeConsentStore;
  const artifact = yield* ProbeArtifact;
  return yield* GCP.Healthcare.DatasetsConsentStoresConsent("ProbeGrant", {
    consentStore: store.name,
    userId: "user-123",
    consentArtifact: artifact.name,
    state: "DRAFT",
  });
});
export const ProbeMapping = Effect.gen(function* () {
  const store = yield* ProbeConsentStore;
  return yield* GCP.Healthcare.DatasetsConsentStoresUserDataMapping("ProbeChart", {
    consentStore: store.name,
    userId: "user-123",
    dataId: "Patient/abc",
  });
});
