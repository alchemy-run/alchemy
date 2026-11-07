import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Schema } from "./Schema.ts";

export interface GetSchemaRequest extends Omit<pubsub.GetProjectsSchemasRequest, "name"> {}

/**
 * Runtime binding for Pub/Sub `schemas.get`.
 *
 * Bind this operation to a {@link Schema} in a Function/Action init phase.
 * Provide {@link GetSchemaHttp}.
 *
 * ### Reading a Schema
 * **Example:** Get the latest revision
 * ```typescript
 * const getSchema = yield* GCP.PubSub.GetSchema(schema);
 * const live = yield* getSchema({ view: "FULL" });
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface GetSchema extends Binding.Service<
  GetSchema,
  "GCP.PubSub.GetSchema",
  (
    schema: Schema,
  ) => Effect.Effect<
    (
      request?: GetSchemaRequest,
    ) => Effect.Effect<pubsub.Pubsub_Schema, pubsub.GetProjectsSchemasError, RuntimeContext>
  >
> {}

export const GetSchema = Binding.Service<GetSchema>("GCP.PubSub.GetSchema");

/**
 * HTTP implementation of {@link GetSchema}.
 *
 * @layer
 * @provides GCP.PubSub.GetSchema
 */
export const GetSchemaHttp = Layer.effect(
  GetSchema,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getSchema = yield* GCPBindings.withCredentials(pubsub.getProjectsSchemas);
    return Effect.fn(function* (schema: Schema) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.PubSub.GetSchema(${schema})`({
          iam: [grantFor({ role: "roles/pubsub.viewer", on: "pubsub.schema" }, schema.name)],
        });
      }
      const name = yield* schema.name;
      return Effect.fn(`GCP.PubSub.GetSchema(${schema.LogicalId})`)(function* (
        request?: GetSchemaRequest,
      ) {
        return yield* getSchema({
          view: "FULL",
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
