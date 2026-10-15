import * as Cloudflare from "alchemy/Cloudflare";
import { backendRuntime } from "./backend-runtime.ts";
import { workerOptions } from "./options.ts";
import { Group20 } from "./rpc-schema.ts";

export default class Backend20 extends Cloudflare.RpcWorker<Backend20>()(
  "RpcBackend20",
  { ...workerOptions, main: import.meta.url, schema: Group20 },
  backendRuntime(Group20),
) {}
