import * as Layer from "effect/Layer";
import { ReadObject } from "./ReadObject.ts";
import { storageHttpLayer } from "./StorageBinding.ts";
import { makeReadObjectBinding } from "./StorageObjectBinding.ts";

/**
 * Typed object reads using a managed storage:read branch credential.
 *
 * @layer
 * @provides ReadObject
 */
export const ReadObjectHttp = Layer.effect(
  ReadObject,
  makeReadObjectBinding("http"),
).pipe(Layer.provide(storageHttpLayer));
