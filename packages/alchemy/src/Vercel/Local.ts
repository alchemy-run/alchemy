/**
 * The Vercel local-provider sidecar entry (`alchemy dev`): serves every
 * Vercel local provider over RPC so provider state (running dev servers,
 * proxies, the {@link LocalFunctionState} registry) survives user-code hot
 * reloads. Referenced by `LOCAL_ENTRY_URL` in `LocalRuntime.ts` — future
 * Vercel local providers (queue broker, EdgeConfig registry) must register
 * HERE so they share one sidecar process and its state.
 */
import * as Layer from "effect/Layer";
import * as RpcServer from "../Local/RpcServer.ts";
import { VercelAuth } from "./AuthProvider.ts";
import { LocalBlobStoreProvider } from "./Blob/LocalBlobStoreProvider.ts";
import * as Credentials from "./Credentials.ts";
import {
  LocalEdgeConfigProvider,
  LocalEdgeConfigTokenProvider,
} from "./EdgeConfig/LocalEdgeConfigProvider.ts";
import { LocalFunctionProvider } from "./Functions/LocalFunctionProvider.ts";
import { localVercelServices } from "./LocalRuntime.ts";
import * as VercelEnvironment from "./VercelEnvironment.ts";

// Management-API access for the delegating paths (e.g. the EdgeConfigToken
// local provider minting a REAL token for an `Alchemy.remote()` Edge
// Config). Resolution is lazy (`Effect.cached` inside the layers), so a
// sidecar without Vercel credentials still serves pure-local stacks.
const vercelServices = Layer.provide(
  Layer.merge(Credentials.fromAuthProvider(), VercelEnvironment.fromProfile()),
  VercelAuth,
);

Layer.mergeAll(
  LocalFunctionProvider(),
  LocalBlobStoreProvider(),
  LocalEdgeConfigProvider(),
  LocalEdgeConfigTokenProvider(),
).pipe(
  Layer.provide(localVercelServices()),
  Layer.provide(vercelServices),
  RpcServer.launch,
);
