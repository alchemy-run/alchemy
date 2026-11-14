# @alchemy.run/effect-cluster

[Effect Cluster](https://effect.website) for [Alchemy](https://alchemy.run). Effect Cluster runs stateful, addressable programs across a group of processes. An entity has one instance per id, like a chat room or a cart, and handles its messages one at a time. Instances are spread over runners by shard, and a Postgres database records which runner owns each shard and keeps the messages that must survive a restart. Deploy the database and a pool of runners on Docker, AWS, GCP, Kubernetes, Fly or Hetzner, or run each instance as a Durable Object on Cloudflare.

```sh
npm install alchemy @alchemy.run/effect-cluster @alchemy.run/docker effect
```

A pool of runners, and the database they coordinate through:

```typescript
// src/Cluster.ts
import * as ClusterDocker from "@alchemy.run/effect-cluster/Docker";
import * as Layer from "effect/Layer";

export const Database = ClusterDocker.Database("Cluster");

export const Default = ClusterDocker.SwarmPool("Default").pipe(Layer.provide(Database));
```

An entity, declared with its messages and its implementation, on that pool:

```typescript
// src/Room.ts
import * as Cluster from "@alchemy.run/effect-cluster";
import { Entity } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { Default } from "./Cluster.ts";

const Rooms = Entity.make("Room", [
  Rpc.make("Join", { payload: { name: Schema.String }, success: Schema.Int }),
]);

export default class Room extends Cluster.Entity<Room>()(
  Rooms,
  { main: import.meta.url },
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const members = yield* Ref.make(new Set<string>());
      return Rooms.of({
        Join: ({ payload }) =>
          Ref.modify(members, (all) => {
            const next = new Set(all).add(payload.name);
            return [next.size, next];
          }),
      });
    });
  }).pipe(Effect.provide(Default)),
) {}
```

Any runtime calls a room by its id:

```typescript
// src/Api.ts
import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Room from "./Room.ts";

export default class Api extends Docker.Service<Api>()(
  "Api",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const rooms = yield* Room;
    return {
      fetch: Effect.gen(function* () {
        const lobby = yield* rooms.getByName("lobby");
        const members = yield* lobby.Join({ name: "sam" });
        return yield* HttpServerResponse.json({ members });
      }).pipe(Effect.orDie),
    };
  }),
) {}
```

And the Stack deploys the Api, which brings the room, the pool and the database with it:

```typescript
// alchemy.run.ts
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Docker from "@alchemy.run/docker";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "Rooms",
  {
    providers: Layer.mergeAll(Docker.providers(), Cluster.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { api: api.name };
  }),
);
```

Swap `ClusterDocker` for `ClusterAWS`, `ClusterFly` or another cloud, and the room doesn't change.

Docs: [alchemy.run/cluster](https://alchemy.run/cluster) · [Setup](https://alchemy.run/cluster/setup) · [Tutorial](https://alchemy.run/cluster/tutorial/part-1). Reference: [alchemy.run/providers](https://alchemy.run/providers).
