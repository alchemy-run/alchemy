import { resolve } from "node:path";
import { parseArgs } from "node:util";

// Reuse the existing bounded load driver without changing its behavior. This
// stack intentionally reuses /rpc-shape for a real Cloudflare DO RPC, so mark
// that different meaning in the saved manifest after the driver completes.
const args = Bun.argv.slice(2);
const { values } = parseArgs({
  args,
  strict: true,
  options: {
    url: { type: "string" },
    variant: { type: "string" },
    revision: { type: "string" },
    output: { type: "string" },
    endpoints: { type: "string" },
    requests: { type: "string" },
    warmups: { type: "string" },
    concurrency: { type: "string" },
    ops: { type: "string" },
    "timeout-ms": { type: "string" },
    "run-id": { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log("Dispatch benchmark: same flags as load.ts. Select noop, effect-ops, or rpc-shape.");
  console.log(
    "rpc-shape executes one real Durable Object RPC per request; --ops 0 selects its no-op method.",
  );
}
const endpoints = (values.endpoints ?? "noop,effect-ops,rpc-shape").split(",");
if (
  !values.help &&
  endpoints.some((endpoint) => !["noop", "effect-ops", "rpc-shape"].includes(endpoint))
) {
  throw new Error("Dispatch endpoints are noop,effect-ops,rpc-shape");
}
if (!values.help && values.ops !== undefined && Number(values.ops) > 10_000) {
  throw new Error("Dispatch --ops is capped at 10000");
}
const output = values.output === undefined ? undefined : resolve(values.output);
if (!values.help && output !== undefined && (await Bun.file(output).exists())) {
  throw new Error(`Refusing to overwrite ${output}`);
}
const forwarded = [...args];
if (values.endpoints === undefined) forwarded.push("--endpoints", endpoints.join(","));
const child = Bun.spawn([process.execPath, `${import.meta.dir}/load.ts`, ...forwarded], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
const exitCode = await child.exited;

if (!values.help && output !== undefined && (await Bun.file(output).exists())) {
  const result = await Bun.file(output).json();
  const parseBody = (text: string | null) => {
    try {
      return JSON.parse(text ?? "null");
    } catch {
      return null;
    }
  };
  const before = parseBody(result.health.before.body);
  const after = parseBody(result.health.after.body);
  const correctStack =
    before?.diagnostic === "dispatch" &&
    after?.diagnostic === "dispatch" &&
    typeof before.tracing === "boolean" &&
    before.tracing === after.tracing;
  result.benchmark = {
    kind: "deployed-worker-and-durable-object-dispatch",
    correctStack,
    tracing: before?.tracing ?? null,
    objectName: before?.objectName ?? null,
    endpointSemantics: {
      noop: "WorkerBridge + HttpServer Effect fetch, no user work",
      "effect-ops": "Named Effect.fn primitive loop inside Worker",
      "rpc-shape":
        result.configuration.operations === 0
          ? "One real Durable Object noop RPC per HTTP request"
          : "One real Durable Object loop RPC per HTTP request; named Effect.fn primitives inside the actor",
    },
    cpuScope:
      "Worker invocation CPU excludes the remote Durable Object invocation CPU; collect and report both separately",
    expectedMeasuredDurableObjectCalls: result.workloads
      .filter((workload: { endpoint: string }) => workload.endpoint === "rpc-shape")
      .reduce(
        (sum: number, workload: { measured: { samples: unknown[] } }) =>
          sum + workload.measured.samples.length,
        0,
      ),
  };
  result.allCorrect &&= correctStack;
  await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`);
  if (!correctStack)
    console.error("The URL did not return a consistent dispatch benchmark identity");
  process.exitCode = exitCode || (result.allCorrect ? 0 : 1);
} else {
  process.exitCode = exitCode;
}
