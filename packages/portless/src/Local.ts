/**
 * The Portless providers served by the dev sidecar (see `Local/Sidecar.ts`):
 * `Dev` commands and `Alias` routes belong to the sidecar's process, which
 * outlives reloads of the user's stack program, so their routes do too.
 */
import { CommandExecutorLive } from "alchemy/Command/Command";
import type * as RpcServer from "alchemy/Local/RpcServer";
import * as Layer from "effect/Layer";
import { AliasProviderLocal } from "./Alias.ts";
import { DevProviderLocal } from "./Dev.ts";

export default Layer.mergeAll(DevProviderLocal(), AliasProviderLocal()).pipe(
  Layer.provide(CommandExecutorLive()),
) satisfies RpcServer.ProviderLayer;
