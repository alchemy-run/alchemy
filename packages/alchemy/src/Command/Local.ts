import * as RpcServer from "../Local/RpcServer.ts";
import { DevProviderLocal } from "./Dev.ts";

DevProviderLocal().pipe(RpcServer.launch);
