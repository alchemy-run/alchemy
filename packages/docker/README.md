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
      sharedMemorySize: "256m",
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

A network can be internal, attachable, and pinned to an explicit subnet:

```typescript
const internalNetwork = yield* Docker.Network("InternalNetwork", {
  internal: true,
  attachable: true,
  ipam: {
    config: [{ subnet: "10.50.0.0/24", gateway: "10.50.0.1" }],
  },
});
```

Without `ipam`, Docker picks the subnet and gateway. Network settings are fixed at creation, so changing one replaces the network. See [local services](https://alchemy.run/docker/local-services) for dual-stack networks and driver options.

Container network attachments reuse the same `Network` resource. Endpoint-specific settings belong on `Docker.Container`, not on the network:

```typescript
yield* Docker.Container("Api", {
  image: "nginx:alpine",
  hostname: "api",
  networks: [{
    name: internalNetwork.name,
    aliases: ["api"],
    ipv4Address: "10.50.0.10",
  }],
  start: true,
});
```

`ipv4Address`, `ipv6Address`, `gatewayPriority` and `endpointDriverOpts` configure each attachment. Changing an attachment reconnects it; changing container DNS or hostname recreates the container.

## Container runtime options

`sharedMemorySize: "256m"` sets `/dev/shm` independently of the `memory` limit.
The container must use a private or shareable IPC namespace.

```typescript
yield* Docker.Container("Worker", {
  image: "alpine:3.22",
  platform: "linux/amd64",
  entrypoint: "/bin/sh",
  command: ["-c", "echo ready"],
  workingDirectory: "/workspace",
  ipcNamespace: "private",
  sysctls: { "net.ipv4.ip_unprivileged_port_start": "1024" },
  keepStdinOpen: true,
  allocatePseudoTerminal: true,
});
```

`pidNamespace`, `gpuDevices` and `privileged` are optional host-dependent
controls. Changing create-time settings replaces the container; keep
persistent data in volumes.

## Learn more

- [Docker on alchemy.run](https://alchemy.run/docker)
- [Setup](https://alchemy.run/docker/setup)
- [Build and push images](https://alchemy.run/docker/build-and-push)
- [API reference](https://alchemy.run/providers)
