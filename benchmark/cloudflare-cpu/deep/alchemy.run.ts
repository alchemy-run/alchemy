import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Backend1 from "./backend-1.ts";
import Backend20 from "./backend-20.ts";
import Backend100 from "./backend-100.ts";
import Front from "./worker.ts";

/** Deploy the source revision in this worktree; preserve local state between variants. */
export default Alchemy.Stack(
  "CloudflareDeepCpuBenchmark",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const front = yield* Front;
    const one = yield* Backend1;
    const twenty = yield* Backend20;
    const hundred = yield* Backend100;
    return {
      frontUrl: front.url.as<string>(),
      frontWorkerName: front.workerName,
      frontWorkerId: front.workerId,
      frontUploadedVersion: front.versionId,
      namespaces: front.durableObjectNamespaces,
      rpc1: {
        name: one.workerName,
        id: one.workerId,
        url: one.url.as<string>(),
        uploadedVersion: one.versionId,
      },
      rpc20: {
        name: twenty.workerName,
        id: twenty.workerId,
        url: twenty.url.as<string>(),
        uploadedVersion: twenty.versionId,
      },
      rpc100: {
        name: hundred.workerName,
        id: hundred.workerId,
        url: hundred.url.as<string>(),
        uploadedVersion: hundred.versionId,
      },
    };
  }),
);
