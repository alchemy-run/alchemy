import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { PlainDispatchObject, TracedDispatchObject } from "./dispatch-object.ts";
import { dispatchLoop, dispatchMaximumCount, dispatchObjectName } from "./dispatch-work.ts";

const headers = { "cache-control": "no-store" };

export const dispatchOptions = {
  compatibility: { date: "2026-09-01" },
  workersDev: true,
  cache: { enabled: false },
  build: { output: { sourcemap: "hidden" as const } },
  observability: {
    enabled: true,
    headSamplingRate: 1,
    logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
  },
};

export const dispatchImplementation = (
  target: typeof PlainDispatchObject | typeof TracedDispatchObject,
  tracing: boolean,
) =>
  Effect.gen(function* () {
    const objects = yield* target;
    const version = yield* Cloudflare.Workers.VersionMetadata();

    return {
      // This normal Effect-native fetch handler passes through the production
      // HttpServer.makeRequestEffect and WorkerBridge on every HTTP invocation.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://dispatch.invalid");
        if (request.method !== "GET") {
          return HttpServerResponse.text("GET required", { status: 405, headers });
        }
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json(
            {
              ok: true,
              harness: "cloudflare-cpu-v1",
              diagnostic: "dispatch",
              tracing,
              objectName: dispatchObjectName,
              version: yield* version,
              features: {
                uint8ArrayToBase64:
                  typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 ===
                  "function",
                uint8ArrayFromBase64:
                  typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 ===
                  "function",
              },
            },
            { headers },
          );
        }
        if (url.pathname === "/noop") {
          return yield* HttpServerResponse.json({ ok: true, endpoint: "noop" }, { headers });
        }
        if (url.pathname === "/do-identity") {
          const actorId = yield* objects.getByName(dispatchObjectName).identity();
          return yield* HttpServerResponse.json(
            { ok: true, tracing, actorId, objectName: dispatchObjectName },
            { headers },
          );
        }
        if (url.pathname !== "/effect-ops" && url.pathname !== "/rpc-shape") {
          return HttpServerResponse.text("Not found", { status: 404, headers });
        }
        const rawCount = url.searchParams.get("count") ?? "1000";
        const count = Number(rawCount);
        if (
          !/^\d+$/.test(rawCount) ||
          !Number.isSafeInteger(count) ||
          count > dispatchMaximumCount
        ) {
          return HttpServerResponse.text(`count must be between 0 and ${dispatchMaximumCount}`, {
            status: 400,
            headers,
          });
        }
        const endpoint = url.pathname.slice(1);
        const checksum =
          endpoint === "effect-ops"
            ? yield* dispatchLoop(count)
            : count === 0
              ? yield* objects.getByName(dispatchObjectName).noop()
              : yield* objects.getByName(dispatchObjectName).loop(count);
        if (checksum !== (count * (count + 1)) / 2) {
          return yield* Effect.die(new Error("Dispatch checksum mismatch"));
        }
        return yield* HttpServerResponse.json(
          {
            ok: true,
            endpoint,
            count,
            checksum,
            execution: endpoint === "effect-ops" ? "worker" : "durable-object-rpc",
          },
          { headers },
        );
      }),
    };
  });
