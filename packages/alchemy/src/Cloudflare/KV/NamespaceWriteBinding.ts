import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import {
  KVNamespaceWrite,
  type WriteKVNamespaceClient,
} from "./NamespaceWrite.ts";

/**
 * Implementation of the {@link KVNamespaceWrite} service that uses a Worker
 * binding.
 */
export const WriteNamespaceBinding = Layer.effect(
  KVNamespaceWrite,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeWriteKVClient }),
  ),
);

/** Build the write half of the binding client. */
export const makeWriteKVClient = ({
  use,
}: ReturnType<typeof makeKVNamespaceHelpers>): WriteKVNamespaceClient => {
  return {
    put: ((...args: Parameters<runtime.KVNamespace["put"]>) =>
      use((raw) => raw.put(...args))) as any,
    delete: ((...args: Parameters<runtime.KVNamespace["delete"]>) =>
      use((raw) => raw.delete(...args))) as any,
  };
};
