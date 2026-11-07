import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDocumentSchemaHttpBinding } from "./BindingHttp.ts";
import type { DocumentSchema } from "./DocumentSchema.ts";

export interface GetDocumentSchemaRequest extends Omit<
  cw.GetProjectsLocationsDocumentSchemasRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI Warehouse `documentSchemas.get`.
 *
 * Bind this operation to a {@link DocumentSchema} in a Function/Action
 * init phase. Provide {@link GetDocumentSchemaHttp}.
 *
 * ### Reading Schemas
 * **Example:** Read the bound schema
 * ```typescript
 * const getSchema = yield* GCP.ContentWarehouse.GetDocumentSchema(schema);
 * const live = yield* getSchema();
 * ```
 *
 * @binding
 * @category ContentWarehouse
 */
export interface GetDocumentSchema extends Binding.Service<
  GetDocumentSchema,
  "GCP.ContentWarehouse.GetDocumentSchema",
  (
    schema: DocumentSchema,
  ) => Effect.Effect<
    (
      request?: GetDocumentSchemaRequest,
    ) => Effect.Effect<
      cw.GoogleCloudContentwarehouseV1DocumentSchema,
      cw.GetProjectsLocationsDocumentSchemasError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentSchema = Binding.Service<GetDocumentSchema>(
  "GCP.ContentWarehouse.GetDocumentSchema",
);

/**
 * HTTP implementation of {@link GetDocumentSchema}.
 *
 * @layer
 * @provides GCP.ContentWarehouse.GetDocumentSchema
 */
export const GetDocumentSchemaHttp = Layer.effect(
  GetDocumentSchema,
  makeDocumentSchemaHttpBinding({
    tag: "GCP.ContentWarehouse.GetDocumentSchema",
    operation: cw.getProjectsLocationsDocumentSchemas,
    iam: { role: "roles/contentwarehouse.documentSchemaViewer" },
  }),
);
