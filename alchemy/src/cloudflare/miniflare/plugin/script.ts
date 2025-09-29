export const SCRIPT_MULTIWORKER_DISPATCHER = `
// src/workers/multiworker/dispatcher.worker.ts
var dispatcher_worker_default = {
  async fetch(request, env) {
    let headerName = env.HEADER_NAME || "MF-target-worker", targetWorker = request.headers.get(headerName);
    if (!targetWorker)
      return env.DEFAULT_WORKER.fetch(request);
    let forwardRequest = new Request(request);
    forwardRequest.headers.delete(headerName);
    let workerBinding = \`WORKER_\${targetWorker.toUpperCase()}\`, targetService = env[workerBinding];
    if (!targetService || typeof targetService == "string") {
      let availableWorkers = Object.keys(env).filter((key) => key.startsWith("WORKER_")).map((key) => key.replace("WORKER_", "").toLowerCase());
      return new Response(
        JSON.stringify({
          error: \`Worker '\${targetWorker}' not found\`,
          available_workers: availableWorkers,
          request_url: request.url,
          request_method: request.method,
          header_used: headerName
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    return targetService.fetch(forwardRequest);
  }
};
export {
  dispatcher_worker_default as default
};
//# sourceMappingURL=dispatcher.worker.js.map
`;
