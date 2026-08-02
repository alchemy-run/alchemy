import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CommandExecutorLive } from "../Command/Command.ts";
import * as RpcServer from "../Local/RpcServer.ts";
import { DatabaseProviderLocal } from "./LocalDatabase.ts";

// Sidecar entry for the local Database provider. Mirrors Command/Local.ts:
// the long-running `spacetime dev --server-only` process lives here so it
// survives user-code HMR during `alchemy dev`.
DatabaseProviderLocal().pipe(
  Layer.provide(CommandExecutorLive()),
  Layer.provide(FetchHttpClient.layer),
  RpcServer.launch,
);
