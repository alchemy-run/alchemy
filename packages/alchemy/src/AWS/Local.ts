/**
 * Entry point of the AWS local dev sidecar process.
 *
 * Spawned by the RPC spawner the first time the engine (running under
 * `alchemy dev`) touches an AWS local provider. Providers hosted here — and
 * their state: the AppSync Events subscription, bundle watchers, and handler
 * child processes — outlive the engine's `--watch` restarts, which is what
 * keeps Live Lambda sessions warm across code edits.
 */
import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import * as RpcServer from "../Local/RpcServer.ts";
import { AwsAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import * as Endpoint from "./Endpoint.ts";
import { Default as DefaultEnvironment } from "./Environment.ts";
import { LocalFunctionProvider } from "./Lambda/FunctionProvider.ts";
import { localRuntimeServices } from "./LocalRuntime.ts";
import * as Region from "./Region.ts";

const awsServices = Layer.mergeAll(
  Credentials.fromEnvironment,
  Region.fromEnvironment,
  Endpoint.fromEnvironment,
).pipe(
  Layer.provideMerge(DefaultEnvironment),
  Layer.provideMerge(AwsAuth),
  Layer.provideMerge(CredentialsStoreLive),
);

LocalFunctionProvider().pipe(
  Layer.provide(localRuntimeServices()),
  Layer.provide(awsServices),
  RpcServer.launch,
);
