import * as RpcServer from "../../Dev/RpcServer.ts";
import { ServerProviderLocal } from "./Server.ts";

ServerProviderLocal().pipe(RpcServer.launch);
