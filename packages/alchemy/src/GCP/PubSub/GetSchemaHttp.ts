import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetSchema, type GetSchemaRequest } from "./GetSchema.ts";
import type { Schema } from "./Schema.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link GetSchema}.
 *
 * @layer
 * @provides GCP.PubSub.GetSchema
 */
export const GetSchemaHttp = Layer.effect(
  GetSchema,
  Effect.gen(function* () {
    const getSchema = yield* pubsub.getProjectsSchemas;
    return Effect.fn(function* (schema: Schema) {
      yield* bindGcpHost({
        tag: "GCP.PubSub.GetSchema",
        resource: schema,
        iam: [{ role: defaultRoleFor("GCP.PubSub.GetSchema") }],
      });
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
