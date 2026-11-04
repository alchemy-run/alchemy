import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSchemaVersionHttpBinding } from "./BindingHttp.ts";
import type { SchemasSchemaVersion } from "./SchemasSchemaVersion.ts";

export interface GetSchemaVersionRequest extends Omit<
  documentai.GetProjectsLocationsSchemasSchemaVersionsRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI `schemaVersions.get`.
 *
 * Bind this operation to a {@link SchemasSchemaVersion} in a
 * Function/Action init phase. Provide {@link GetSchemaVersionHttp}.
 *
 * ### Reading a Schema Version
 * **Example:** Read the bound schema version
 * ```typescript
 * const getVersion = yield* GCP.DocumentAI.GetSchemaVersion(version);
 * const live = yield* getVersion();
 * ```
 *
 * @binding
 * @category DocumentAI
 */
export interface GetSchemaVersion extends Binding.Service<
  GetSchemaVersion,
  "GCP.DocumentAI.GetSchemaVersion",
  (
    version: SchemasSchemaVersion,
  ) => Effect.Effect<
    (
      request?: GetSchemaVersionRequest,
    ) => Effect.Effect<
      documentai.GoogleCloudDocumentaiV1SchemaVersion,
      documentai.GetProjectsLocationsSchemasSchemaVersionsError,
      RuntimeContext
    >
  >
> {}

export const GetSchemaVersion = Binding.Service<GetSchemaVersion>(
  "GCP.DocumentAI.GetSchemaVersion",
);

/**
 * HTTP implementation of {@link GetSchemaVersion}.
 *
 * @layer
 * @provides GCP.DocumentAI.GetSchemaVersion
 */
export const GetSchemaVersionHttp = Layer.effect(
  GetSchemaVersion,
  makeSchemaVersionHttpBinding({
    tag: "GCP.DocumentAI.GetSchemaVersion",
    operation: documentai.getProjectsLocationsSchemasSchemaVersions,
    iam: { role: "roles/documentai.viewer" },
  }),
);
