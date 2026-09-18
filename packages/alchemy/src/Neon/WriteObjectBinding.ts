import * as Layer from "effect/Layer";
import { WriteObject } from "./WriteObject.ts";
import { storageHttpLayer } from "./StorageBinding.ts";
import { makeWriteObjectBinding } from "./StorageObjectBinding.ts";

/**
 * Typed object writes using injected or automatically scoped credentials.
 *
 * @layer
 * @provides WriteObject
 */
export const WriteObjectBinding = Layer.effect(
  WriteObject,
  makeWriteObjectBinding("binding"),
).pipe(Layer.provide(storageHttpLayer));
