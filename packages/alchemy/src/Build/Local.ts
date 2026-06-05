import { LocalDevServerProvider } from "../Build/DevServer.ts";
import * as RpcServer from "../Local/RpcServer.ts";

LocalDevServerProvider().pipe(RpcServer.launch);
