# @alchemy.run/docker

Docker for [Alchemy](https://alchemy.run). Declare images, containers, networks, and volumes as typed resources, driven through your active Docker context. Other Alchemy providers use it to build and push the images they deploy.

```sh
npm install alchemy @alchemy.run/docker effect
```

A local Postgres with a generated password, a network, and a data volume:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.merge(Docker.providers(), Alchemy.RandomProvider()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const password = yield* Alchemy.makeRandom("PostgresPassword", { bytes: 16 });
    const image = yield* Docker.RemoteImage("Postgres", { name: "postgres", tag: "18-alpine" });
    const network = yield* Docker.Network("Network");
    const data = yield* Docker.Volume("Data");

    const postgres = yield* Docker.Container("Db", {
      image,
      environment: { POSTGRES_PASSWORD: password },
      ports: [{ external: 15432, internal: 5432 }],
      volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql/data" }],
      networks: [{ name: network.name, aliases: ["postgres"] }],
      start: true,
    });

    return { container: postgres.name };
  }),
);
```

`alchemy deploy` pulls the image and starts the container. Change a prop and the next deploy replaces only what changed; `alchemy destroy` removes all of it.

## Network configuration

Within a Stack's `Effect.gen`, networks can be isolated, made attachable and assigned explicit IPAM settings:

```typescript
const internalNetwork = yield* Docker.Network("InternalNetwork", {
  internal: true,
  attachable: true,
  ipam: {
    config: [{ subnet: "10.50.0.0/24", gateway: "10.50.0.1" }],
  },
});
```

Docker assigns a subnet and gateway if none are provided. Network creation options are immutable; changing them replaces the network, and Docker will refuse to remove it while containers are attached. `internal` restricts traffic through that network, not through a container's other network connections. See [local services](https://alchemy.run/docker/local-services) for driver options and IPv6-only configuration.

## Learn more

- [Docker on alchemy.run](https://alchemy.run/docker)
- [Setup](https://alchemy.run/docker/setup)
- [Build and push images](https://alchemy.run/docker/build-and-push)
- [API reference](https://alchemy.run/providers)
