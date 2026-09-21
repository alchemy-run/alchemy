import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  type makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import { WriteNamespace, type WriteNamespaceClient } from "./WriteNamespace.ts";

/**
 * Native Celld KV writes. Streams and blobs are not supported by Celld 0.5.
 *
 * @layer
 * @provides Celld.KV.WriteNamespace
 * @product KV
 */
export const WriteNamespaceBinding = Layer.effect(
  WriteNamespace,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeWriteKVClient }),
  ),
);

/** Build the write half of the native namespace client. */
export const makeWriteKVClient = ({
  use,
}: ReturnType<typeof makeKVNamespaceHelpers>): WriteNamespaceClient => ({
  put: (key, value, options) =>
    use((binding) => {
      if (
        typeof value !== "string" &&
        !(value instanceof ArrayBuffer) &&
        !ArrayBuffer.isView(value)
      ) {
        throw new Error(
          "Celld 0.5 KV put supports only strings, ArrayBuffers and typed arrays; streams and blobs are unsupported",
        );
      }
      return binding.put(key, value, options);
    }),
  delete: (key) => use((binding) => binding.delete(key)),
});
