import type { WorkerOptions } from "miniflare";
import {
  MULTIWORKER_BINDING,
  TARGET_WORKER_HEADER,
  type MultiWorkerOptions,
} from "./schema.ts";

export const DISPATCH_WORKER: WorkerOptions & MultiWorkerOptions = {
  name: "alchemy-dispatcher",
  modules: [
    {
      type: "ESModule",
      path: "main.mjs",
      contents: `export default {
            async fetch(request, env) {
                try {
                    const targetWorker = request.headers.get('${TARGET_WORKER_HEADER}');
                    if (targetWorker) {
                        return env.${MULTIWORKER_BINDING}.fetch(request);
                    }
                    throw new Error('alchemy dispatcher error: request target worker header missing: ${TARGET_WORKER_HEADER}');
                } catch (error) {
                    console.error("[alchemy-dispatcher] error", error);
                    return new Response('Error: ' + error.message, { status: 502 });
                }
            }
        }`,
    },
  ],
  multiworkerRouting: {
    enabled: true,
    dispatcherBinding: MULTIWORKER_BINDING,
  },
};
