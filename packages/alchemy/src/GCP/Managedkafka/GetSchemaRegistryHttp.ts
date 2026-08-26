import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import { GetSchemaRegistry } from "./GetSchemaRegistry.ts";
import type { SchemaRegistry } from "./SchemaRegistry.ts";

/**
 * HTTP implementation of {@link GetSchemaRegistry}.
 *
 * @layer
 * @provides GCP.Managedkafka.GetSchemaRegistry
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
    tag: "GCP.Managedkafka.GetSchemaRegistry",
    operation: kafka.getProjectsLocationsSchemaRegistries,
  }),
);
