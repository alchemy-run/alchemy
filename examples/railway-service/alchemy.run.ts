/**
 * A Railway project that exercises every resource and binding:
 *
 * - `Site` — parent Project (`src/shared.ts`)
 * - `Staging` — extra Environment (production is on the Project)
 * - `Marker` — shared Variable the Api reads via `Config.string`
 * - `Disk` — Volume the Worker mounts with `MountVolume`
 * - `Db` — Postgres + `ConnectPostgres` / Drizzle
 * - `Cache` — Redis + `ReadWriteRedis`
 * - `CacheProxy` — TcpProxy so Redis is reachable from a laptop
 * - `Data` — Bucket + Put/Get/Head/List/Delete
 * - `Echo` — image Service (`hashicorp/http-echo`)
 * - `Api` — Effect HTTP Service (`src/api.ts`)
 * - `Worker` — Effect background Service that writes the volume
 *   (`src/worker.ts`)
 *
 * Effect-native images are pushed to `RAILWAY_REGISTRY` (GHCR / Docker
 * Hub). Railway has no private registry of its own.
 *
 * CustomDomain needs a hostname you control. Pass
 * `RAILWAY_TEST_DOMAIN` to attach one to Api.
 */
import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Echo } from "./src/echo.ts";
import {
  Cache,
  CacheProxy,
  Data,
  Db,
  Disk,
  Marker,
  Site,
  Staging,
} from "./src/shared.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "RailwayService",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const staging = yield* Staging;
    const marker = yield* Marker;
    const disk = yield* Disk;
    const db = yield* Db;
    const cache = yield* Cache;
    const cacheProxy = yield* CacheProxy;
    const data = yield* Data;
    const echo = yield* Echo;
    const worker = yield* Worker;
    const api = yield* Api;

    const domain = process.env.RAILWAY_TEST_DOMAIN;
    const www =
      domain === undefined || domain.length === 0
        ? undefined
        : yield* Railway.CustomDomain("Www", {
            service: api,
            environment: site,
            domain,
            targetPort: 3000,
          });

    const workspace = yield* Railway.currentWorkspace();
    const regions = yield* Railway.listRegions();

    return {
      projectId: site.projectId,
      projectName: site.name,
      projectUrl: site.url,
      environmentId: site.environmentId,
      stagingId: staging.environmentId,
      stagingName: staging.name,
      secretName: marker.name,
      volumeId: disk.volumeId,
      postgresServiceId: db.serviceId,
      postgresName: db.name,
      postgresPublic: db.publicConnectionUri,
      redisServiceId: cache.serviceId,
      redisProxy: `${cacheProxy.domain}:${cacheProxy.proxyPort}`,
      bucketId: data.bucketId,
      echoUrl: echo.url,
      apiServiceId: api.serviceId,
      apiName: api.name,
      apiUrl: api.url,
      workerServiceId: worker.serviceId,
      customDomain: www?.domain,
      workspaceId: workspace.id,
      regionCount: regions.length,
    };
  }),
);
