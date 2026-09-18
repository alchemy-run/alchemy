import * as Layer from "effect/Layer";
import { ReadObject } from "./ReadObject.ts";
import { storageHttpLayer } from "./StorageBinding.ts";
import { makeReadObjectBinding } from "./StorageObjectBinding.ts";

/**
 * Typed object reads using injected or automatically scoped credentials.
 *
 * @layer
 * @provides ReadObject
 */
export const ReadObjectBinding = Layer.effect(
  ReadObject,
  makeReadObjectBinding("binding"),
).pipe(Layer.provide(storageHttpLayer));
