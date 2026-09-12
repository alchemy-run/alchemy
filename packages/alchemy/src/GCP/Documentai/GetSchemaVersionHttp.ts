import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeSchemaVersionHttpBinding } from "./BindingHttp.ts";
import { GetSchemaVersion } from "./GetSchemaVersion.ts";

/**
 * HTTP implementation of {@link GetSchemaVersion}.
 *
 * @layer
 * @provides GCP.Documentai.GetSchemaVersion
 */
export const GetSchemaVersionHttp = Layer.effect(
  GetSchemaVersion,
  makeSchemaVersionHttpBinding({
    tag: "GCP.Documentai.GetSchemaVersion",
    operation: documentai.getProjectsLocationsSchemasSchemaVersions,
  }),
);
