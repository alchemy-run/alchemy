import * as Effect from "effect/Effect";
import * as RpcProvider from "../Local/RpcProvider.ts";
import { LiveLambdaRuntimeLive } from "./Lambda/Live/LiveRuntime.ts";

/**
 * Entry module of the AWS local dev sidecar process (see `./Local.ts`).
 *
 * `import.meta.resolve(<string>)` is a runtime API — TypeScript's
 * `rewriteRelativeImportExtensions` does NOT touch the string literal, so we
 * pick the extension from `import.meta.url`: `.ts` when running from `src/`
 * (bun / tests), `.js` from the compiled `lib/` (published package).
 */
export const AWS_LOCAL_ENTRY_URL = import.meta.resolve(
  import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
  import.meta.url,
);

/**
 * Runtime services for AWS local dev providers. Only constructed inside the
 * sidecar process (dev mode, no RPC proxy) — in the engine process the
 * providers are RPC stubs and these layers stay empty.
 */
export const localRuntimeServices = () =>
  RpcProvider.providerServicesEffect(
    Effect.sync(() => LiveLambdaRuntimeLive()),
  );
