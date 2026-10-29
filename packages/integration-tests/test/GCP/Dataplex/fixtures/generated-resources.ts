import * as GCP from "@alchemy.run/gcp";

/** Dataplex resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeDataProduct = GCP.Dataplex.DataProduct("ProbeDataProduct", {
  location: "us-central1",
  displayName: "Sales mart",
  description: "product a",
  ownerEmails: ["owner@example.com"],
});
export const ProbeEntryGroup = GCP.Dataplex.EntryGroup("ProbeEntryGroup", {
  location: "us-central1",
  displayName: "catalog a",
  description: "group a",
});
export const ProbeEntryType = GCP.Dataplex.EntryType("ProbeEntryType", {
  location: "us-central1",
  displayName: "table a",
  description: "type a",
  typeAliases: ["TABLE"],
  platform: "GCS",
  system: "Cloud Storage",
});
export const ProbeGlossary = GCP.Dataplex.Glossary("ProbeGlossary", {
  location: "us-central1",
  displayName: "glossary a",
  description: "glossary a",
});
export const ProbeLake = GCP.Dataplex.Lake("ProbeLake", {
  location: "us-central1",
  displayName: "lake a",
  description: "lake a",
});
