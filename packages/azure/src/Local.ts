/**
 * The Azure provider group served by the dev sidecar (see
 * `alchemy/Local/Sidecar.ts`): the local `Azure.Functions.Function`
 * provider, whose Node.js processes outlive user-code reloads.
 */
import type * as RpcServer from "alchemy/Local/RpcServer";
import { LocalFunctionProvider } from "./Functions/LocalFunctionProvider.ts";

export default LocalFunctionProvider() satisfies RpcServer.ProviderLayer;
