import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Backend1 from "./backend-1.ts";
import Backend20 from "./backend-20.ts";
import Backend100 from "./backend-100.ts";
import { actorName, maximumRpcCalls, workerOptions } from "./options.ts";
import { RpcObject1, RpcObject20, RpcObject100 } from "./rpc-objects.ts";
import { ScheduledObject } from "./scheduled-object.ts";
import { SqlObject } from "./sql-object.ts";

const headers = { "cache-control": "no-store" };

export default Cloudflare.Worker(
  "DeepFrontWorker",
  {
    ...workerOptions,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const backends = {
      1: yield* Cloudflare.RpcWorker.bind(Backend1),
      20: yield* Cloudflare.RpcWorker.bind(Backend20),
      100: yield* Cloudflare.RpcWorker.bind(Backend100),
    };
    const objects = { 1: yield* RpcObject1, 20: yield* RpcObject20, 100: yield* RpcObject100 };
    const sqlObjects = yield* SqlObject;
    const scheduledObjects = yield* ScheduledObject;
    const version = yield* Cloudflare.Workers.VersionMetadata();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://deep.invalid");
        const isPreparation = url.pathname === "/deep/scheduled-prepare";
        if (request.method !== (isPreparation ? "POST" : "GET"))
          return HttpServerResponse.text(isPreparation ? "POST required" : "GET required", {
            status: 405,
            headers,
          });
        if (url.pathname === "/health")
          return yield* HttpServerResponse.json(
            {
              ok: true,
              harness: "cloudflare-deep-v1",
              version: yield* version,
              baseline: "source revision supplied by the load manifest",
              actorName,
            },
            { headers },
          );
        if (url.pathname === "/deep/noop")
          return yield* HttpServerResponse.json(
            {
              ok: true,
              endpoint: "deep/noop",
              variant: "worker-noop",
              count: 0,
              checksum: 0,
              version: yield* version,
            },
            { headers },
          );

        const rpc = /^\/deep\/(rpc-worker|rpc-do)(?:-(1|20|100))?$/.exec(url.pathname);
        const isSql = url.pathname === "/deep/sql" || url.pathname === "/deep/sql-noop";
        const isScheduled = url.pathname === "/deep/scheduled" || isPreparation;
        if (!rpc && !isSql && !isScheduled)
          return HttpServerResponse.text("Not found", { status: 404, headers });
        const defaultCount = isScheduled
          ? "100"
          : isSql
            ? url.pathname === "/deep/sql-noop"
              ? "0"
              : "100"
            : "20";
        const rawCount = url.searchParams.get("count") ?? defaultCount;
        const count = Number(rawCount);
        if (
          !/^\d+$/.test(rawCount) ||
          !Number.isSafeInteger(count) ||
          count > maximumRpcCalls ||
          (rpc && count < 1) ||
          (url.pathname === "/deep/sql" && count !== 100 && count !== 1000) ||
          (isScheduled && count !== 100 && count !== 1000) ||
          (url.pathname === "/deep/sql-noop" && count !== 0)
        ) {
          return HttpServerResponse.text("Invalid bounded operation count", {
            status: 400,
            headers,
          });
        }
        const endpoint = url.pathname.slice(1);
        if (isScheduled) {
          const actor = scheduledObjects.getByName(actorName);
          const result = yield* isPreparation ? actor.prepare(count) : actor.drain(count);
          return yield* HttpServerResponse.json(
            {
              ok: true,
              endpoint,
              variant: isPreparation ? "scheduled-prepare" : "native-rpc-public-scheduled-events",
              ...result,
              version: yield* version,
            },
            { headers },
          );
        }
        if (isSql) {
          const actor = sqlObjects.getByName(actorName);
          const result = yield* count === 0 ? actor.noop() : actor.writeRead(count);
          return yield* HttpServerResponse.json(
            {
              ok: true,
              endpoint,
              variant: count === 0 ? "native-rpc-noop" : "native-rpc-public-sql-transaction",
              ...result,
              version: yield* version,
            },
            { headers },
          );
        }

        const groupSize = Number(rpc![2] ?? 20) as 1 | 20 | 100;
        const kind = rpc![1];
        // The DO client is created once per HTTP invocation, then reused only
        // within that invocation. RpcWorker.bind retains its actual public
        // per-unary-call behavior. Neither client crosses request boundaries.
        const client =
          kind === "rpc-worker"
            ? backends[groupSize]
            : yield* objects[groupSize].getByName(actorName);
        let checksum = 0;
        let actorId = "";
        let remoteVersion = "";
        for (let index = 0; index < count; index++) {
          const result = yield* client.call({ value: index + 1 });
          if (
            result.value !== index + 1 ||
            (kind === "rpc-worker"
              ? result.actorId !== ""
              : !/^[0-9a-f]{64}$/.test(result.actorId)) ||
            !result.versionId ||
            (index > 0 && (result.actorId !== actorId || result.versionId !== remoteVersion))
          ) {
            return yield* Effect.die(new Error("RPC result or actor identity mismatch"));
          }
          actorId = result.actorId;
          remoteVersion = result.versionId;
          checksum += result.value;
        }
        return yield* HttpServerResponse.json(
          {
            ok: true,
            endpoint,
            variant: kind === "rpc-worker" ? "rpc-worker-bind-http" : "rpc-durable-object-http",
            count,
            rpcCalls: count,
            groupSize,
            checksum,
            actorId,
            remoteVersion,
            version: yield* version,
          },
          { headers },
        );
      }).pipe(Effect.scoped, Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.VersionMetadataBinding)),
);
