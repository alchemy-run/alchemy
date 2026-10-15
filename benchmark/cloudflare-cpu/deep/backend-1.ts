import * as Cloudflare from "alchemy/Cloudflare";
import { backendRuntime } from "./backend-runtime.ts";
import { workerOptions } from "./options.ts";
import { Group1 } from "./rpc-schema.ts";

export default class Backend1 extends Cloudflare.RpcWorker<Backend1>()(
  "RpcBackend1",
  { ...workerOptions, main: import.meta.url, schema: Group1 },
  backendRuntime(Group1),
) {}
