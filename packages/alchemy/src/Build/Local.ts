import { LocalDevCommandProvider } from "../Build/DevCommand.ts";
import * as RpcServer from "../Local/RpcServer.ts";

LocalDevCommandProvider().pipe(RpcServer.launch);
