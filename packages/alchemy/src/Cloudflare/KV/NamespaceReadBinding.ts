import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import {
  KVNamespaceRead,
  type ReadKVNamespaceClient,
} from "./NamespaceRead.ts";

/**
 * Implementation of the {@link KVNamespaceRead} service that uses a Worker
 * binding.
 */
export const ReadNamespaceBinding = Layer.effect(
  KVNamespaceRead,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeReadKVClient }),
  ),
);

/** Build the read half of the binding client. */
export const makeReadKVClient = ({
  raw,
  use,
}: ReturnType<typeof makeKVNamespaceHelpers>): ReadKVNamespaceClient => {
  return {
    raw,
    get: ((...args: Parameters<runtime.KVNamespace["get"]>) =>
      use((raw) => raw.get(...(args as [any, any])))) as any,
    getWithMetadata: ((
      ...args: Parameters<runtime.KVNamespace["getWithMetadata"]>
    ) => use((raw) => raw.getWithMetadata(...(args as [any, any])))) as any,
    list: ((...args: Parameters<runtime.KVNamespace["list"]>) =>
      use((raw) => raw.list(...args))) as any,
  };
};
