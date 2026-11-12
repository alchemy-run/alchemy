# @alchemy.run/rivet

[Rivet](https://rivet.dev) for [Alchemy](https://alchemy.run). Rivet is an open-source platform for Actors: long-lived programs that each have a name and their own state, like one chat room, one game or one user's session. Its engine stores each Actor's data, starts it on a node when it's called, puts it to sleep when it goes quiet, and sends every call for a name to the one Actor that owns it. Run the engine and its nodes on Docker, AWS, GCP, Kubernetes, Fly, Hetzner or Railway, or use Rivet Cloud.

```sh
npm install alchemy @alchemy.run/rivet @alchemy.run/docker effect
```

In Alchemy an Actor is a `Rivet.DurableObject`, the same shape as a Cloudflare Durable Object, and the control plane and its nodes are Layers. A pool of nodes, given the control plane it joins:

```typescript
// src/cluster.ts
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Layer from "effect/Layer";

export const Cluster = RivetDocker.SwarmControlPlane("Rivet");

export const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(Cluster));
```

A Durable Object on that pool, with what each instance can do:

```typescript
// src/room.ts
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { Default } from "./cluster.ts";

export default class Room extends Rivet.DurableObject<Room>()(
  "Room",
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Rivet.DurableObjectState;
      return {
        join: () =>
          state.storage.transaction(
            Effect.gen(function* () {
              const visitors = ((yield* state.storage.get<number>("visitors")) ?? 0) + 1;
              yield* state.storage.put("visitors", visitors);
              return visitors;
            }),
          ),
      };
    });
  }).pipe(Effect.provide(Default)),
) {}
```

Any runtime calls a room by its name, and the first call to a name starts that room. Here a Docker service on the control plane's network:

```typescript
// src/api.ts
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Cluster } from "./cluster.ts";
import Room from "./room.ts";

export default class Api extends Docker.Service<Api>()(
  "Api",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: 3000, internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
    };
  }).pipe(Effect.provide(Cluster)),
  Effect.gen(function* () {
    const rooms = yield* Room;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const [, name] = new URL(request.url, "http://api").pathname.split("/");
        const visitors = yield* rooms.getByName(name || "lobby").join();
        return yield* HttpServerResponse.json({ visitors });
      }),
    };
  }),
) {}
```

The Stack only names the Api. The room comes with it, and the pool and the control plane come with the room:

```typescript
// alchemy.run.ts
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/api.ts";

export default Alchemy.Stack(
  "RivetRooms",
  {
    providers: Layer.mergeAll(Docker.providers(), Rivet.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { service: api.name };
  }),
);
```

Swap `RivetDocker` for `RivetAWS`, `RivetHetzner` or another cloud, and the room doesn't change.

## Schedules and crons

Each Durable Object instance can schedule one-shot work and recurring jobs that call its own RPC methods, using RivetKit's scheduler:

```typescript
const state = yield* Rivet.DurableObjectState;

// One-shot: run `sendReminder` in 5 seconds
yield* state.schedule.after(5_000, "sendReminder", { text: "hello" });

// Recurring: refresh on every wake so existing actors pick up changes
yield* state.cron.set({
  name: "daily",
  expression: "0 9 * * *",
  action: "report",
});
```

`Rivet.Cron` is a Durable Object dedicated to one job. After deploy, call `getByName(...).arm()` once so the actor exists for RivetKit to schedule.

## Effect Workflows

`Rivet.Workflows.layerDurableObjectEngine` runs Effect's `WorkflowEngine` on Rivet Durable Objects (same engine as Cloudflare's Durable Object Workflows). Provide a pool and the module that exports the workflows Layer:

```typescript
export const WorkflowsLive = SendWelcomeLive.pipe(
  Layer.provideMerge(
    Rivet.Workflows.layerDurableObjectEngine({
      main: import.meta.url,
      handler: "WorkflowsLive",
      pool: Default,
    }),
  ),
);
```

Each workflow execution is one actor instance, with its journal in SQLite and wake-ups on the actor's alarm.

## agentOS (Sandbox)

A services pool hosts Rivet's agentOS actor. `Rivet.AgentOs` returns Alchemy Sandbox handles (`exec`, `files`, `start`, `pty`, `getTcpPort`) against that pool:

```typescript
const agentOs = yield* Rivet.AgentOs;
const sandbox = yield* agentOs.getOrCreate("session-1");
const result = yield* sandbox.exec("uname -a");
```

Docs: [alchemy.run/rivet](https://alchemy.run/rivet) · [Setup](https://alchemy.run/rivet/setup) · [Tutorial](https://alchemy.run/rivet/tutorial/part-1). Reference: [alchemy.run/providers](https://alchemy.run/providers).
