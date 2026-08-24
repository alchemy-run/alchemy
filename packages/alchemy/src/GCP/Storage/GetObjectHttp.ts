import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Layer from "effect/Layer";
import { GetObject } from "./GetObject.ts";
import { makeObjectHttpBinding } from "./ObjectHttp.ts";

/**
 * HTTP implementation of {@link GetObject}.
 *
 * @layer
 * @provides GCP.Storage.GetObject
 */
export const GetObjectHttp = Layer.effect(
  GetObject,
  makeObjectHttpBinding({
    tag: "GCP.Storage.GetObject",
    operation: storage.getObjects,
  }),
);
