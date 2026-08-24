import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Layer from "effect/Layer";
import { makeObjectHttpBinding } from "./ObjectHttp.ts";
import { PutObject } from "./PutObject.ts";

/**
 * HTTP implementation of {@link PutObject}.
 *
 * @layer
 * @provides GCP.Storage.PutObject
 */
export const PutObjectHttp = Layer.effect(
  PutObject,
  makeObjectHttpBinding({
    tag: "GCP.Storage.PutObject",
    operation: storage.insertObjects,
  }),
);
