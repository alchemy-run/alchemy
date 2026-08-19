/**
 * A Fly.io app that exercises the full module-scope graph:
 *
 * - `Site` — parent App (`src/shared.ts`)
 * - `Data` — Volume the Worker mounts via `Fly.MountVolume`
 * - `Marker` — App Secret the Api reads via `Fly.ReadSecret`
 * - `PublicIp` — shared IPv4 so `{app}.fly.dev` answers
 * - `Api` — HTTP Service on port 3000 (`src/api.ts`)
 * - `Worker` — background Service that writes the volume marker (`src/worker.ts`)
 *
 * N Services share one App; each Service is its own Machine. A Volume
 * attaches to one Machine — only Worker mounts `Data`.
 */
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Data, Marker, PublicIp, Site } from "./src/shared.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "FlyService",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const volume = yield* Data;
    const secret = yield* Marker;
    const ip = yield* PublicIp;
    const worker = yield* Worker;
    const api = yield* Api;

    return {
      appName: site.appName,
      appId: site.appId,
      appUrl: site.url,
      volumeId: volume.volumeId,
      volumeName: volume.name,
      secretName: secret.name,
      ip: ip.ip,
      workerMachineId: worker.machineId,
      workerName: worker.name,
      workerState: worker.state,
      apiMachineId: api.machineId,
      apiName: api.name,
      apiState: api.state,
      apiUrl: api.url,
      apiRegion: api.region,
    };
  }),
);
