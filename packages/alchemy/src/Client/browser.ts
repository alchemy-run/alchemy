/**
 * The `"browser"`-condition build of `alchemy/client` — the identical
 * public surface with NO server branch at all: the value form
 * (`createClient(Backend)`) falls back to the HTTP wire path (harmless —
 * same protocol), and nothing in this module's graph can reach the
 * serve-bridge/server-only code, keeping client bundles tiny.
 */

import { makeCreateClient, makeCreateEffectClient } from "./Core.ts";

export type {
  AnyBackendClass,
  ClientOptions,
  ClientShape,
  CreateClient,
  CreateEffectClient,
  RpcClient,
  RpcEffectClient,
  RpcFailure,
  RpcMethodShape,
  RpcSuccess,
  ServerClientOptions,
} from "./Core.ts";
export {
  RpcDefectError,
  RpcError,
  RpcMissingUrlError,
  RpcPrerenderError,
  RpcTransportError,
  type RpcClientError,
} from "./Errors.ts";

/** See `index.ts` — browser build: every call takes the HTTP path. */
export const createClient = makeCreateClient(undefined);

/** See `index.ts` — browser build: every call takes the HTTP path. */
export const createEffectClient = makeCreateEffectClient(undefined);
