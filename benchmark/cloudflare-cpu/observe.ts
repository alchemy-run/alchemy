import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const help = `Usage: bun benchmark/cloudflare-cpu/observe.ts --worker NAME --output-prefix PATH [--profile] -- LOAD_ARGS

  --worker NAME          Deployed Worker script name (required)
  --output-prefix PATH   New evidence-file prefix (required; never overwrite)
  --profile              Also capture a 5-second CPU profile during load
  --profile-worker-id ID Override the profile API Worker ID/name; defaults to NAME
  --profile-after-ms N   With --profile, start N ms after load spawn (0–60000)
                        Default: wait for the first matching tail event
  --help                 Show this help

LOAD_ARGS are forwarded to the adjacent load.ts. Supply --url, --variant and
--revision. --output defaults to PREFIX-latency.json; --run-id defaults to cpu-TIMESTAMP.
Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, read from environment.
Only events matching the load origin, run marker, and benchmark routes are saved.
The normal benchmark is unprofiled. Use a separate output prefix for profile runs.
This wrapper has a 239-second hard limit.
`;

type Envelope = { success?: boolean; result?: any; errors?: unknown; [key: string]: unknown };

function argument(args: string[], name: string): string | undefined {
  const occurrences = args.flatMap((arg, index) =>
    arg === name
      ? [args[index + 1]]
      : arg.startsWith(`${name}=`)
        ? [arg.slice(name.length + 1)]
        : [],
  );
  if (occurrences.length > 1) throw new Error(`Supply ${name} only once`);
  if (occurrences.length && (!occurrences[0] || occurrences[0].startsWith("--"))) {
    throw new Error(`Missing value for ${name}`);
  }
  return occurrences[0];
}

async function main() {
  const args = Bun.argv.slice(2);
  const separator = args.indexOf("--");
  const { values } = parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    strict: true,
    options: {
      worker: { type: "string" },
      "output-prefix": { type: "string" },
      profile: { type: "boolean", default: false },
      "profile-worker-id": { type: "string" },
      "profile-namespace-id": { type: "string" },
      "profile-actor-id": { type: "string" },
      "load-script": { type: "string", default: "load" },
      "profile-after-ms": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return console.log(help);
  if (!values.worker || !values["output-prefix"] || separator < 0) throw new Error(help);
  const profileWorkerId = values["profile-worker-id"] ?? values.worker;
  if (!["load", "dispatch-load", "r2-load", "deep/load"].includes(values["load-script"])) {
    throw new Error("--load-script must be load, dispatch-load, r2-load, or deep/load");
  }
  const namespaceId = values["profile-namespace-id"];
  const actorId = values["profile-actor-id"];
  if (
    (namespaceId || actorId) &&
    (!values.profile ||
      !/^[a-f0-9]{32}$/i.test(namespaceId ?? "") ||
      !/^[a-f0-9]{64}$/i.test(actorId ?? ""))
  ) {
    throw new Error(
      "Durable Object profiling requires --profile plus valid namespace and actor IDs",
    );
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(values.worker)) throw new Error("Invalid Worker script name");
  const profileAfterMs =
    values["profile-after-ms"] === undefined ? undefined : Number(values["profile-after-ms"]);
  if (
    profileAfterMs !== undefined &&
    (!values.profile ||
      !Number.isSafeInteger(profileAfterMs) ||
      profileAfterMs < 0 ||
      profileAfterMs > 60_000 ||
      values["profile-after-ms"]!.trim() === "")
  ) {
    throw new Error("--profile-after-ms requires --profile and an integer from 0 to 60000");
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account)
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");
  const loadArgs = args.slice(separator + 1);
  const rawOrigin = argument(loadArgs, "--url") ?? process.env.BENCH_URL;
  if (!rawOrigin) throw new Error("Supply load --url or BENCH_URL");
  const origin = new URL(rawOrigin);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      "Load URL must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  }
  const prefix = resolve(values["output-prefix"]);
  // UUID-shaped values are automatically redacted in Cloudflare tail URLs.
  const runId = argument(loadArgs, "--run-id") ?? `cpu-${Date.now()}`;
  if (!argument(loadArgs, "--run-id")) loadArgs.push("--run-id", runId);
  const loadOutput = resolve(argument(loadArgs, "--output") ?? `${prefix}-latency.json`);
  if (!argument(loadArgs, "--output")) loadArgs.push("--output", loadOutput);
  const paths = {
    tail: `${prefix}-tail.jsonl`,
    observer: `${prefix}-observer.json`,
    versions: `${prefix}-versions.json`,
    deployments: `${prefix}-deployments.json`,
    versionsAfter: `${prefix}-versions-after.json`,
    deploymentsAfter: `${prefix}-deployments-after.json`,
    profile: `${prefix}-cpu.pprof.gz`,
    profileError: `${prefix}-profile-error.json`,
  };
  for (const path of [...Object.values(paths), loadOutput]) {
    if (await Bun.file(path).exists()) throw new Error(`Refusing to overwrite ${path}`);
  }
  await mkdir(dirname(prefix), { recursive: true });
  const startedAt = new Date().toISOString();
  let tailUrl: string | undefined;
  // Never forward credentials to the workload process or put them in evidence.
  const redact = (value: unknown): string => {
    let message = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    message = message.replaceAll(token, "[redacted]");
    if (tailUrl) message = message.replaceAll(tailUrl, "[authenticated tail URL]");
    return message.replace(/wss?:\/\/[^\s"<>]+/g, "[WebSocket URL]");
  };
  const json = (path: string, value: unknown) =>
    writeFile(path, redact(JSON.stringify(value, null, 2)) + "\n", { flag: "wx", mode: 0o600 });
  const controller = new AbortController();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let socket: WebSocket | undefined;
  let closing = false;
  const stop = (reason: string) => {
    if (!controller.signal.aborted) controller.abort(new Error(reason));
    child?.kill("SIGKILL");
    socket?.close();
  };
  const onInterrupt = () => stop("Interrupted");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  // Leave 19 seconds for final metadata, tail DELETE, and evidence flush.
  const deadline = setTimeout(() => stop("Observer exceeded its 220-second work budget"), 220_000);
  const hardDeadline = setTimeout(() => {
    child?.kill("SIGKILL");
    process.exit(124);
  }, 239_000);
  const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${values.worker}`;
  const request = async (url: string, method = "GET", body?: unknown, cleanup = false) => {
    try {
      return await fetch(url, {
        method,
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: cleanup
          ? AbortSignal.timeout(8_000)
          : AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
    } catch {
      throw new Error(`Cloudflare ${method} request failed or timed out`);
    }
  };
  const api = async (path: string, method = "GET", body?: unknown, cleanup = false) => {
    const response = await request(`${apiRoot}${path}`, method, body, cleanup);
    if (response.status === 204 || (cleanup && response.status === 404)) return {} as Envelope;
    let envelope: Envelope;
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      throw new Error(`Cloudflare ${method} ${path} returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || envelope.success === false) {
      throw new Error(
        `Cloudflare ${method} ${path}: HTTP ${response.status}: ${redact(JSON.stringify(envelope.errors))}`,
      );
    }
    return envelope;
  };
  const tail = createWriteStream(paths.tail, { flags: "wx", mode: 0o600 });
  tail.on("error", () => stop("Could not write tail evidence"));
  let tailId: string | undefined;
  let tailDeleted = false;
  let loadExitCode: number | null = null;
  let loadFinished = false;
  let matchingEvents = 0;
  let discardedEvents = 0;
  const discardedShapes: unknown[] = [];
  let malformedMessages = 0;
  let tailBytes = 0;
  let eventsWithCpuFields = 0;
  const observedCpuFields: Record<string, number> = {};
  let failure: string | undefined;
  let profileStatus = values.profile ? "waiting for workload" : "disabled";
  let profileVersion: string | undefined;
  let profileRequestedAt: string | undefined;
  let profileCompletedAt: string | undefined;
  let loadStartedAt: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let firstEvent!: () => void;
  const workloadSeen = new Promise<void>((resolve) => {
    firstEvent = resolve;
  });
  const routes = new Set([
    "/health",
    "/noop",
    "/effect-ops",
    "/rpc-shape",
    "/workflow-codec",
    "/rpc-binary",
    "/rpc-records",
    "/ai-image",
    "/ai-tools",
    "/r2-copy-effect",
    "/r2-copy-native",
  ]);
  try {
    const [versions, deployments] = await Promise.all([api("/versions"), api("/deployments")]);
    await Promise.all([json(paths.versions, versions), json(paths.deployments, deployments)]);
    const active = [...(deployments.result?.deployments ?? [])].sort((a, b) =>
      String(b.created_on).localeCompare(String(a.created_on)),
    )[0];
    const activeVersions = active?.versions?.filter((version: any) => version.percentage > 0) ?? [];
    profileVersion =
      activeVersions.length === 1 && activeVersions[0].percentage === 100
        ? (activeVersions[0].version_id as string)
        : undefined;
    const created = await api("/tails", "POST", { filters: [] });
    tailId = created.result?.id;
    tailUrl = created.result?.url;
    if (!tailId || typeof tailUrl !== "string" || !tailUrl.startsWith("wss://")) {
      throw new Error("Cloudflare returned an invalid tail session");
    }
    socket = new WebSocket(tailUrl, "trace-v1");
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (message) => {
      try {
        const raw =
          typeof message.data === "string"
            ? message.data
            : new TextDecoder().decode(message.data as ArrayBuffer);
        const decoded = JSON.parse(raw);
        for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
          const eventUrl = event?.event?.request?.url;
          if (typeof eventUrl !== "string") {
            if (discardedShapes.length < 3)
              discardedShapes.push({ keys: Object.keys(event ?? {}), event: event?.event });
            discardedEvents++;
            continue;
          }
          const url = new URL(eventUrl);
          if (
            url.origin !== origin.origin ||
            url.searchParams.get("run") !== runId ||
            (!routes.has(url.pathname) && !url.pathname.startsWith("/deep/"))
          ) {
            if (discardedShapes.length < 3)
              discardedShapes.push({ keys: Object.keys(event ?? {}), url: eventUrl });
            discardedEvents++;
            continue;
          }
          const line = redact(JSON.stringify(event)) + "\n";
          tailBytes += Buffer.byteLength(line);
          if (tailBytes > 64 * 1024 * 1024 || tail.writableLength > 8 * 1024 * 1024) {
            stop("Tail evidence exceeded its bounded buffer budget");
            return;
          }
          tail.write(line);
          matchingEvents++;
          let hasCpuField = false;
          for (const [path, value] of [
            ["cpuTime", event.cpuTime],
            ["cpuTimeMs", event.cpuTimeMs],
            ["cpu_time", event.cpu_time],
            ["cpu_time_ms", event.cpu_time_ms],
            ["$workers.cpuTimeMs", event.$workers?.cpuTimeMs],
          ] as const) {
            if (typeof value === "number" && Number.isFinite(value)) {
              observedCpuFields[path] = (observedCpuFields[path] ?? 0) + 1;
              hasCpuField = true;
            }
          }
          if (hasCpuField) eventsWithCpuFields++;
          firstEvent();
        }
      } catch {
        malformedMessages++;
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Tail connection did not open within 15 seconds")),
        15_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new Error("Tail connection aborted"));
      controller.signal.addEventListener("abort", abort, { once: true });
      socket!.addEventListener("open", () => finish(), { once: true });
      socket!.addEventListener(
        "error",
        () => finish(new Error("Tail WebSocket connection failed")),
        { once: true },
      );
      socket!.addEventListener("close", () => finish(new Error("Tail closed before it opened")), {
        once: true,
      });
    });
    controller.signal.throwIfAborted();
    socket.send(JSON.stringify({ debug: true }));
    socket.addEventListener("error", () => {
      if (!closing) stop("Tail WebSocket failed during capture");
    });
    socket.addEventListener("close", () => {
      if (!closing) stop("Tail closed during capture");
    });
    heartbeat = setInterval(() => {
      try {
        (socket as WebSocket & { ping?: () => void }).ping?.();
      } catch {
        stop("Tail heartbeat failed");
      }
    }, 10_000);
    const {
      CLOUDFLARE_API_TOKEN: _token,
      CLOUDFLARE_ACCOUNT_ID: _account,
      ...loadEnv
    } = process.env;
    child = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, `${values["load-script"]}.ts`), ...loadArgs],
      {
        env: loadEnv,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    loadStartedAt = new Date().toISOString();
    const exited = child.exited.then((code) => {
      loadFinished = true;
      loadExitCode = code;
    });
    const profile = values.profile
      ? (async () => {
          let triggerTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            const trigger =
              profileAfterMs === undefined
                ? workloadSeen
                : new Promise<void>((resolve) => {
                    triggerTimer = setTimeout(resolve, profileAfterMs);
                  });
            await Promise.race([trigger, exited]);
            if (loadFinished || controller.signal.aborted)
              throw new Error("Load ended before a profile could start");
            if (!profileVersion || !/^[a-f0-9-]{36}$/i.test(profileVersion)) {
              throw new Error("Profiling requires one active deployed version at 100 percent");
            }
            profileStatus = "capturing";
            profileRequestedAt = new Date().toISOString();
            const response = await request(
              `https://api.cloudflare.com/client/v4/accounts/${account}/workers/workers/${encodeURIComponent(profileWorkerId)}/versions/${profileVersion}/profile`,
              "POST",
              {
                duration_ms: 5_000,
                profile_type: "cpu",
                ...(namespaceId ? { namespace_id: namespaceId, actor_id: actorId } : {}),
              },
            );
            const bytes = new Uint8Array(await response.arrayBuffer());
            // Bun fetch may decompress a Content-Encoding:gzip transport response.
            // Recompress in that case so the artifact always matches its .gz suffix.
            if (!response.ok || response.headers.get("content-type")?.includes("json")) {
              throw new Error(
                `Profile HTTP ${response.status}: ${redact(new TextDecoder().decode(bytes))}`,
              );
            }
            await writeFile(
              paths.profile,
              bytes[0] === 0x1f && bytes[1] === 0x8b ? bytes : Bun.gzipSync(bytes),
              { flag: "wx", mode: 0o600 },
            );
            profileStatus = "saved";
          } catch (error) {
            profileStatus = "failed";
            await json(paths.profileError, { error: redact(error), at: new Date().toISOString() });
          } finally {
            if (triggerTimer !== undefined) clearTimeout(triggerTimer);
            profileCompletedAt = new Date().toISOString();
          }
        })()
      : Promise.resolve();
    await exited;
    if (controller.signal.aborted) throw controller.signal.reason;
    await profile;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (controller.signal.aborted) throw controller.signal.reason;
    const after = await Promise.allSettled([
      api("/versions").then((value) => json(paths.versionsAfter, value)),
      api("/deployments").then((value) => json(paths.deploymentsAfter, value)),
    ]);
    for (const result of after) if (result.status === "rejected") throw result.reason;
    if (loadExitCode !== 0) throw new Error(`Load exited with code ${loadExitCode}`);
    if (matchingEvents === 0)
      console.warn(
        "No matching live tail events; collect stored invocation CPU before comparing this cohort",
      );
  } catch (error) {
    failure = redact(error);
    child?.kill("SIGKILL");
  } finally {
    closing = true;
    clearTimeout(deadline);
    if (heartbeat) clearInterval(heartbeat);
    socket?.close();
    if (tailId) {
      try {
        await api(`/tails/${encodeURIComponent(tailId)}`, "DELETE", undefined, true);
        tailDeleted = true;
      } catch (error) {
        failure = [failure, `Tail cleanup failed: ${redact(error)}`].filter(Boolean).join("; ");
      }
    }
    await new Promise<void>((resolve) => {
      if (tail.destroyed) resolve();
      else tail.end(() => resolve());
    });
    await json(paths.observer, {
      schemaVersion: 1,
      worker: values.worker,
      runId,
      origin: origin.origin,
      startedAt,
      endedAt: new Date().toISOString(),
      profiled: values.profile,
      profileStatus,
      profileTrigger: values.profile
        ? profileAfterMs === undefined
          ? "first-tail-event"
          : "load-spawn-delay"
        : null,
      profileAfterMs: profileAfterMs ?? null,
      profileWorkerId,
      profileNamespaceId: namespaceId ?? null,
      profileActorId: actorId ?? null,
      profileVersion,
      profileRequestedAt,
      profileCompletedAt,
      loadStartedAt,
      loadOutput,
      loadExitCode,
      matchingEvents,
      discardedEvents,
      discardedShapes,
      malformedMessages,
      tailBytes,
      eventsWithCpuFields,
      observedCpuFields,
      tailDeleted,
      error: failure ?? null,
      notes:
        "Tail records are raw matching benchmark events. Missing CPU fields remain missing, never inferred from client latency. Tail coverage is not guaranteed by the provider.",
    });
    clearTimeout(hardDeadline);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
  console.log(
    JSON.stringify({
      observer: paths.observer,
      tail: paths.tail,
      matchingEvents,
      tailDeleted,
      profileStatus,
    }),
  );
  if (failure) throw new Error(failure);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Observer failed");
  process.exitCode = 1;
});
