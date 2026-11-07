import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import type { SchemaRegistry } from "./SchemaRegistry.ts";

export interface GetSchemaRegistryRequest extends Omit<
  kafka.GetProjectsLocationsSchemaRegistriesRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `schemaRegistries.get`.
 *
 * Bind this operation to a {@link SchemaRegistry} in a Function/Action
 * init phase. Provide {@link GetSchemaRegistryHttp}.
 *
 * Grants `roles/managedkafka.schemaRegistryViewer` (read-only) on the
 * project: schema-registry permission checks do not honor an IAM
 * Condition scoped to the registry's resource name.
 *
 * ### Observing Schema Registries
 * **Example:** Read the bound registry
 * ```typescript
 * const getRegistry = yield* GCP.ManagedKafka.GetSchemaRegistry(registry);
 * const live = yield* getRegistry();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetSchemaRegistry extends Binding.Service<
  GetSchemaRegistry,
  "GCP.ManagedKafka.GetSchemaRegistry",
  (
    registry: SchemaRegistry,
  ) => Effect.Effect<
    (
      request?: GetSchemaRegistryRequest,
    ) => Effect.Effect<
      kafka.SchemaRegistry,
      kafka.GetProjectsLocationsSchemaRegistriesError,
      RuntimeContext
    >
  >
> {}

export const GetSchemaRegistry = Binding.Service<GetSchemaRegistry>(
  "GCP.ManagedKafka.GetSchemaRegistry",
);

/**
 * HTTP implementation of {@link GetSchemaRegistry}.
 *
 * @layer
 * @provides GCP.ManagedKafka.GetSchemaRegistry
 */
export const GetSchemaRegistryHttp: Layer.Layer<
  GetSchemaRegistry,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetSchemaRegistry,
  makeManagedKafkaHttpBinding<SchemaRegistry>()<
    kafka.GetProjectsLocationsSchemaRegistriesRequest,
    kafka.SchemaRegistry,
    kafka.GetProjectsLocationsSchemaRegistriesError
  >({
    tag: "GCP.ManagedKafka.GetSchemaRegistry",
    // Schema-registry permission checks do not match a resource-name IAM
    // Condition on the registry (the conditioned grant stayed denied live),
    // so the read-only viewer role is granted on the project.
    iam: { role: "roles/managedkafka.schemaRegistryViewer" },
    operation: kafka.getProjectsLocationsSchemaRegistries,
  }),
);
