import * as RpcServer from "../../Dev/RpcServer.ts";
import { ServerProviderLocal } from "../../Website/Server.ts";

ServerProviderLocal().pipe(RpcServer.launch);
