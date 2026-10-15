import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

// Raw WebSocket framing matches RpcWebSocket.test.ts. HTTP RPC uses NDJSON;
// RpcDurableObject's actual WebSocket transport uses one JSON frame/message.
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  strict: true,
  options: {
    url: { type: "string" },
    variant: { type: "string" },
    revision: { type: "string" },
    output: { type: "string" },
    ops: { type: "string" },
    trials: { type: "string" },
    "metadata-bytes": { type: "string" },
    "warmup-calls": { type: "string" },
    "timeout-ms": { type: "string" },
    "run-id": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`WebSocket held-stream benchmark. Required: --url --variant --revision --output
--ops 100|1000 (default1000), --trials 1..3 (default3), --metadata-bytes 0|1024|both (defaultboth)
--warmup-calls 0|100 (default0): optional distinct warmup session on each trial's same actor/socket
--timeout-ms 1000..120000 (default60000): whole trial deadline, including optional warmup and close
--run-id: short alphanumeric/hyphen/underscore ID. c1 only, no retries, new actor per trial.
Raw client/server frames and exact request IDs are saved. Report native DO CPU separately from client latency.`);
  process.exit(0);
}
const integer = (value: string | undefined, fallback: number, min: number, max: number) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return n;
};
const rawUrl = values.url ?? process.env.BENCH_URL;
if (!rawUrl || !values.variant || !values.revision || !values.output)
  throw new Error("Required: --url --variant --revision --output");
const origin = new URL(rawUrl);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
) {
  throw new Error("URL must be an origin without credentials, path, query, or fragment");
}
const count = integer(values.ops, 1000, 100, 1000);
if (count !== 100 && count !== 1000) throw new Error("--ops must be 100 or 1000");
const trialsPerSize = integer(values.trials, 3, 1, 3);
const timeoutMs = integer(values["timeout-ms"], 60000, 1000, 120000);
const warmupCalls = integer(values["warmup-calls"], 0, 0, 100);
if (warmupCalls !== 0 && warmupCalls !== 100) throw new Error("--warmup-calls must be 0 or 100");
const metadataOption = values["metadata-bytes"] ?? "both";
if (!["0", "1024", "both"].includes(metadataOption))
  throw new Error("--metadata-bytes must be 0, 1024, or both");
const metadataSizes = metadataOption === "both" ? [0, 1024] : [Number(metadataOption)];
const runId = values["run-id"] ?? `ws-${Date.now()}`;
if (!/^[a-zA-Z0-9_-]{1,60}$/.test(runId))
  throw new Error("run-id must be 1..60 alphanumeric, underscore, or hyphen characters");
const output = resolve(values.output);
if (await Bun.file(output).exists()) throw new Error(`Refusing to overwrite ${output}`);
await mkdir(dirname(output), { recursive: true });

type Json = Record<string, unknown>;
type WireFrame = {
  direction: "client" | "server";
  at: string;
  elapsedMs: number;
  raw: string;
  message: Json;
};
const object = (value: unknown): Json => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a protocol object");
  return value as Json;
};
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const formatError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const health = async () => {
  const at = new Date().toISOString();
  const response = await fetch(new URL("/health", origin), {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  const body = object(await response.json());
  const version = object(body.version);
  assert(
    response.status === 200 &&
      body.ok === true &&
      body.harness === "cloudflare-websocket-v1" &&
      typeof version.id === "string",
    "Health/version mismatch",
  );
  return { at, status: response.status, body, versionId: version.id as string };
};

const connect = async (url: URL, deadline: number, frames: WireFrame[], start: number) => {
  const parser = RpcSerialization.json.makeUnsafe();
  const socket = new WebSocket(url);
  const queue: Json[] = [];
  const waiters: Array<{
    predicate: (message: Json) => boolean;
    resolve: (message: Json) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let failure: Error | undefined;
  let bytes = 0;
  let closeResult: { code: number; reason: string; wasClean: boolean } | undefined;
  let resolveClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const record = (direction: WireFrame["direction"], raw: string, message: Json) => {
    bytes += new TextEncoder().encode(raw).byteLength;
    if (frames.length >= 10000 || bytes > 4 * 1024 * 1024)
      throw new Error("Bounded wire capture exceeded");
    frames.push({
      direction,
      at: new Date().toISOString(),
      elapsedMs: performance.now() - start,
      raw,
      message,
    });
  };
  socket.addEventListener("message", (event) => {
    try {
      if (typeof event.data !== "string") throw new Error("Expected a text JSON WebSocket frame");
      const decoded = parser.decode(event.data);
      if (decoded.length !== 1) throw new Error("Expected one protocol message per server frame");
      const message = object(decoded[0]);
      record("server", event.data, message);
      if (message._tag === "Defect" || message._tag === "ClientProtocolError")
        throw new Error(`Server protocol failure: ${event.data}`);
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index === -1) queue.push(message);
      else {
        const waiter = waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    } catch (error) {
      fail(new Error(formatError(error)));
      socket.close(1000, "invalid response");
    }
  });
  socket.addEventListener("error", () => fail(new Error("WebSocket error")));
  socket.addEventListener("close", (event) => {
    closeResult = { code: event.code, reason: event.reason, wasClean: event.wasClean };
    fail(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
    resolveClose();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        socket.close();
        reject(new Error("WebSocket open deadline"));
      },
      Math.max(1, deadline - performance.now()),
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket handshake failed"));
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket closed before handshake completed"));
      },
      { once: true },
    );
  });
  const receive = (requestId: string, tag: "Exit" | "Chunk") => {
    if (failure) return Promise.reject(failure);
    const predicate = (message: Json) => message.requestId === requestId && message._tag === tag;
    const index = queue.findIndex(predicate);
    if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]!);
    return new Promise<Json>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(
          () => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(new Error(`Deadline waiting for ${requestId} ${tag}`));
          },
          Math.max(1, deadline - performance.now()),
        ),
      };
      waiters.push(waiter);
    });
  };
  const send = (message: Json) => {
    if (failure) throw failure;
    if (performance.now() >= deadline) throw new Error("Trial deadline exceeded");
    const raw = parser.encode(message);
    if (typeof raw !== "string") throw new Error("JSON serializer did not produce a text frame");
    record("client", raw, message);
    socket.send(raw);
  };
  const request = async (id: string, tag: string, payload: Json) => {
    send({ _tag: "Request", id, tag, payload, headers: [] });
    const message = await receive(id, "Exit");
    const exit = object(message.exit);
    assert(exit._tag === "Success", `RPC ${id} failed: ${JSON.stringify(message)}`);
    return exit.value;
  };
  return {
    socket,
    send,
    receive,
    request,
    close: async () => {
      if (socket.readyState !== WebSocket.CLOSED) socket.close(1000, "benchmark complete");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Socket close deadline")),
              Math.max(1, Math.min(5000, deadline - performance.now())),
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      assert(closeResult?.code === 1000, `Unexpected close ${JSON.stringify(closeResult)}`);
      return closeResult;
    },
  };
};

const startedAt = new Date().toISOString();
const before = await health();
const trials = [];
for (const metadataBytes of metadataSizes)
  for (let trialIndex = 0; trialIndex < trialsPerSize; trialIndex++) {
    const token = `${runId}-m${metadataBytes}-t${trialIndex}`;
    const actorName = token;
    const url = new URL(`/rpc/${actorName}`, origin);
    url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    const trialStart = performance.now();
    const frames: WireFrame[] = [];
    const trialStartedAt = new Date().toISOString();
    const deadline = trialStart + timeoutMs;
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    let close: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["close"]>> | null = null;
    let error: string | null = null;
    let warmup: unknown = null;
    let measured: unknown = null;
    try {
      connection = await connect(url, deadline, frames, trialStart);
      let socketIdentity: { actorId: unknown; connectionId: unknown } | undefined;
      const session = async (phase: string, n: number) => {
        const sessionToken = `${token}-${phase}`;
        const startIndex = frames.length;
        const start = performance.now();
        const at = new Date().toISOString();
        const identity = object(
          await connection!.request(`${phase}-begin`, "begin", {
            runToken: sessionToken,
            count: n,
            metadataBytes,
          }),
        );
        assert(
          identity.runToken === sessionToken &&
            identity.count === n &&
            identity.metadataBytes === metadataBytes &&
            identity.versionId === before.versionId &&
            typeof identity.actorId === "string" &&
            /^[0-9a-f]{64}$/.test(identity.actorId) &&
            Number.isSafeInteger(identity.connectionId),
          "Session identity mismatch",
        );
        assert(
          socketIdentity === undefined ||
            (socketIdentity.actorId === identity.actorId &&
              socketIdentity.connectionId === identity.connectionId),
          "Actor/socket changed between warmup and measurement",
        );
        socketIdentity = { actorId: identity.actorId, connectionId: identity.connectionId };
        connection!.send({
          _tag: "Request",
          id: `${phase}-hold`,
          tag: "hold",
          payload: {},
          headers: [],
        });
        const chunk = await connection!.receive(`${phase}-hold`, "Chunk");
        assert(
          Array.isArray(chunk.values) && chunk.values.length === 1,
          "Held stream first chunk mismatch",
        );
        const heldIdentity = object(chunk.values[0]);
        assert(
          Object.entries(identity).every(([key, value]) => heldIdentity[key] === value),
          "Held stream identity mismatch",
        );
        connection!.send({ _tag: "Ack", requestId: `${phase}-hold` });
        let checksum = 0;
        const callsStart = performance.now();
        const callsStartedAt = new Date().toISOString();
        for (let index = 1; index <= n; index++) {
          const result = await connection!.request(`${phase}-short-${index}`, "short", { index });
          assert(result === index, `Unary result mismatch at ${index}`);
          checksum += index;
        }
        const callsEndedAt = new Date().toISOString();
        const callsLatencyMs = performance.now() - callsStart;
        assert(
          (await connection!.request(`${phase}-release`, "release", {})) === true,
          "Held stream release failed",
        );
        const holdExit = object((await connection!.receive(`${phase}-hold`, "Exit")).exit);
        assert(holdExit._tag === "Success", "Held stream did not complete successfully");
        const finish = object(await connection!.request(`${phase}-finish`, "finish", {}));
        for (const [key, value] of Object.entries(identity))
          assert(finish[key] === value, `Finish identity mismatch: ${key}`);
        assert(
          finish.calls === n &&
            finish.checksum === (n * (n + 1)) / 2 &&
            finish.checksum === checksum &&
            finish.held === false &&
            finish.metadataPreserved === true,
          "Finish checksum/state mismatch",
        );
        const sessionFrames = frames.slice(startIndex);
        const requests = sessionFrames.filter(
          (frame) => frame.direction === "client" && frame.message._tag === "Request",
        );
        const sent = sessionFrames.filter((frame) => frame.direction === "client");
        const received = sessionFrames.filter((frame) => frame.direction === "server");
        assert(
          requests.length === n + 4 && sent.length === n + 5 && received.length === n + 5,
          "Unexpected protocol frame counts",
        );
        return {
          phase,
          runToken: sessionToken,
          startedAt: at,
          endedAt: new Date().toISOString(),
          latencyMs: performance.now() - start,
          callsStartedAt,
          callsEndedAt,
          callsLatencyMs,
          ...identity,
          checksum,
          requestIds: requests.map((frame) => frame.message.id),
          requestCount: requests.length,
          clientFrames: sent.length,
          serverFrames: received.length,
          expectedWebSocketMessageEvents: n + 5,
          firstFrameIndex: startIndex,
          lastFrameIndex: frames.length - 1,
          finish,
          correct: true,
        };
      };
      if (warmupCalls) warmup = await session("warmup", warmupCalls);
      measured = await session("measured", count);
    } catch (cause) {
      error = formatError(cause);
    } finally {
      if (connection)
        try {
          close = await connection.close();
        } catch (cause) {
          error ??= formatError(cause);
        }
    }
    if (error === null && frames.length !== 2 * (count + 5 + (warmupCalls ? warmupCalls + 5 : 0))) {
      error = "Unexpected trailing or missing wire frames";
    }
    const result = {
      trialIndex,
      metadataBytes,
      actorName,
      url: url.href,
      startedAt: trialStartedAt,
      endedAt: new Date().toISOString(),
      latencyMs: performance.now() - trialStart,
      warmup,
      measured,
      close,
      frames,
      correct: error === null && measured !== null,
      error,
    };
    trials.push(result);
    console.log(JSON.stringify({ actorName, metadataBytes, correct: result.correct, error }));
    // Persist completed and failed trials immediately; no request is retried.
    await Bun.write(
      output,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          harness: "cloudflare-websocket-v1",
          runId,
          url: origin.origin,
          variant: values.variant,
          revision: values.revision,
          startedAt,
          endedAt: new Date().toISOString(),
          configuration: {
            count,
            trialsPerSize,
            metadataSizes,
            warmupCalls,
            concurrency: 1,
            timeoutMs,
          },
          health: { before },
          trials,
          complete: false,
          allCorrect: false,
        },
        null,
        2,
      )}\n`,
    );
  }
let after: Awaited<ReturnType<typeof health>> | null = null;
let healthError: string | null = null;
try {
  after = await health();
} catch (error) {
  healthError = formatError(error);
}
const versionStable = after?.versionId === before.versionId;
const allCorrect = versionStable && trials.every((trial) => trial.correct);
await Bun.write(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      harness: "cloudflare-websocket-v1",
      runId,
      url: origin.origin,
      variant: values.variant,
      revision: values.revision,
      startedAt,
      endedAt: new Date().toISOString(),
      configuration: {
        count,
        trialsPerSize,
        metadataSizes,
        warmupCalls,
        concurrency: 1,
        timeoutMs,
      },
      health: { before, after, error: healthError },
      versionBefore: before.versionId,
      versionAfter: after?.versionId ?? null,
      versionStable,
      trials,
      complete: true,
      allCorrect,
      notes:
        "Production RpcDurableObject framed JSON transport. One held stream overlaps all ordered unary calls on one socket. Unique actor per trial; optional warmup is on that same actor/socket and has a distinct token/window. CPU requires native DO event aggregation by exact actor, version, and measured trial window; client latency is not CPU. Whole-actor CPU includes connection/setup/release/finish/close, so preserve both whole-trial and measured-session windows. Raw frames contain only synthetic benchmark data. No retries or per-message server logging.",
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ output, allCorrect, versionStable }));
if (!allCorrect) process.exitCode = 1;
