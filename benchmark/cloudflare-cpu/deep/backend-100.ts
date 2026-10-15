import * as Cloudflare from "alchemy/Cloudflare";
import { backendRuntime } from "./backend-runtime.ts";
import { workerOptions } from "./options.ts";
import { Group100 } from "./rpc-schema.ts";

export default class Backend100 extends Cloudflare.RpcWorker<Backend100>()(
  "RpcBackend100",
  { ...workerOptions, main: import.meta.url, schema: Group100 },
  backendRuntime(Group100),
) {}
