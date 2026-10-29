import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";

/** ContentWarehouse resources the generated bindings bind, mirroring each resource suite's smallest shape. */
export const ProbeDocument = Effect.gen(function* () {
  const schema = yield* GCP.ContentWarehouse.DocumentSchema("ProbeDocumentSchema", {
    location: "us",
    displayName: "probe note",
    propertyDefinitions: [{ name: "title", isSearchable: true, textTypeOptions: {} }],
  });
  return yield* GCP.ContentWarehouse.Document("ProbeDocument", {
    location: "us",
    documentSchemaName: schema.name,
    displayName: "probe",
    title: "probe",
    plainText: "hello warehouse",
  });
});
