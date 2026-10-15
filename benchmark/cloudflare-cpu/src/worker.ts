import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  aiWorkloadDescription,
  makeAiWorkloads,
  maximumAiImages,
  maximumAiToolCalls,
} from "./ai-workloads.ts";
import {
  effectOperations,
  harness,
  maximumBinaryChunks,
  maximumOperations,
  queuePacking,
  rpcBinary,
  rpcRecords,
  rpcShape,
  workflowCodec,
} from "./workloads.ts";

const headers = { "cache-control": "no-store" };

/** The actual Alchemy WorkerBridge path; no replacement native fetch handler. */
export default Cloudflare.Worker(
  "CpuWorker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-09-01" },
    workersDev: true,
    cache: { enabled: false },
    build: { output: { sourcemap: "hidden" } },
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: 1,
        persist: true,
      },
      traces: { enabled: false },
    },
  },
  Effect.gen(function* () {
    const version = yield* Cloudflare.Workers.VersionMetadata();
    const ai = yield* makeAiWorkloads;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://benchmark.invalid");
        if (request.method !== "GET") {
          return HttpServerResponse.text("GET required", { status: 405, headers });
        }
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json(
            {
              ok: true,
              harness,
              version: yield* version,
              features: {
                uint8ArrayToBase64:
                  typeof (
                    Uint8Array.prototype as unknown as {
                      toBase64?: unknown;
                    }
                  ).toBase64 === "function",
                uint8ArrayFromBase64:
                  typeof (
                    Uint8Array as unknown as {
                      fromBase64?: unknown;
                    }
                  ).fromBase64 === "function",
              },
            },
            { headers },
          );
        }
        if (url.pathname === "/noop") {
          return yield* HttpServerResponse.json({ ok: true, endpoint: "noop" }, { headers });
        }
        if (
          ![
            "/effect-ops",
            "/rpc-shape",
            "/workflow-codec",
            "/rpc-binary",
            "/rpc-records",
            "/ai-image",
            "/ai-tools",
            "/queue-packing",
          ].includes(url.pathname)
        ) {
          return HttpServerResponse.text("Not found", { status: 404, headers });
        }
        const defaultCount =
          url.pathname === "/ai-image"
            ? "5"
            : url.pathname === "/ai-tools"
              ? "100"
              : url.pathname === "/queue-packing"
                ? "500"
                : "1000";
        const rawCount = url.searchParams.get("count") ?? defaultCount;
        const count = Number(rawCount);
        const maximum =
          url.pathname === "/rpc-binary"
            ? maximumBinaryChunks
            : url.pathname === "/ai-image"
              ? maximumAiImages
              : url.pathname === "/ai-tools"
                ? maximumAiToolCalls
                : url.pathname === "/queue-packing"
                  ? 500
                  : maximumOperations;
        if (!/^\d+$/.test(rawCount) || !Number.isSafeInteger(count) || count > maximum) {
          return HttpServerResponse.text(`count must be an integer from 0 to ${maximum}`, {
            status: 400,
            headers,
          });
        }
        const endpoint = url.pathname.slice(1);
        if (endpoint === "queue-packing") {
          return yield* HttpServerResponse.json(
            { ok: true, endpoint, count, ...(yield* queuePacking(count)) },
            { headers },
          );
        }
        if (endpoint === "ai-image" || endpoint === "ai-tools") {
          const result = yield* endpoint === "ai-image" ? ai.aiImage(count) : ai.aiTools(count);
          return yield* HttpServerResponse.json(
            { ok: true, endpoint, count, diagnostic: aiWorkloadDescription, ...result },
            { headers },
          );
        }
        if (endpoint === "rpc-binary" || endpoint === "rpc-records") {
          const result = yield* endpoint === "rpc-binary" ? rpcBinary(count) : rpcRecords(count);
          return yield* HttpServerResponse.json(
            { ok: true, endpoint, count, ...result },
            { headers },
          );
        }
        const checksum = yield* endpoint === "effect-ops"
          ? effectOperations(count)
          : endpoint === "workflow-codec"
            ? workflowCodec(count)
            : rpcShape(count);
        return yield* HttpServerResponse.json({ ok: true, endpoint, count, checksum }, { headers });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.VersionMetadataBinding)),
);
