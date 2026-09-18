import * as Layer from "effect/Layer";
import { WriteObject } from "./WriteObject.ts";
import { storageHttpLayer } from "./StorageBinding.ts";
import { makeWriteObjectBinding } from "./StorageObjectBinding.ts";

/**
 * Typed object writes using a managed read/write branch credential.
 *
 * @layer
 * @provides WriteObject
 */
export const WriteObjectHttp = Layer.effect(
  WriteObject,
  makeWriteObjectBinding("http"),
).pipe(Layer.provide(storageHttpLayer));
