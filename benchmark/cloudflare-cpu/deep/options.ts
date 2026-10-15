export const workerOptions = {
  compatibility: { date: "2026-09-01" },
  workersDev: true,
  cache: { enabled: false },
  build: { output: { sourcemap: "hidden" as const } },
  observability: {
    enabled: true,
    headSamplingRate: 1,
    logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
    traces: { enabled: false },
  },
};

export const maximumRpcCalls = 1000;
export const actorName = "steady";
