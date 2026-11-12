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

Without `ipam`, Docker picks the subnet and gateway. Network settings are fixed at creation, so changing one replaces the network. See [Networks](https://alchemy.run/docker/networks) for dual-stack networks and driver options.

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

`ipv4Address`, `ipv6Address`, `gatewayPriority` and `driverOpts` configure each attachment. Declared networks do not implicitly join Docker's default `bridge`, including when the only declared network is `internal`. Changing an attachment reconnects it; changing container DNS or hostname recreates the container.

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

## Volume ownership and data safety

`Docker.Volume` creates persistent Docker volumes with a recorded generation identity. Before reconciling or deleting a tracked volume, Alchemy verifies that the Docker volume still matches its recorded identity. An external volume with the same name is not silently adopted or removed. When the previous state is unavailable, even a volume with matching stack labels but a different generation must be explicitly adopted. Pre-generation volumes without that label retain legacy stack-label ownership detection.

To manage an existing volume, explicitly opt into adoption; to reference one without managing its lifecycle, use `Docker.Volume.lookup`:

```typescript
import { adopt } from "alchemy/AdoptPolicy";

const imported = yield* Docker.Volume("ImportedData", {
  name: "existing-data",
}).pipe(adopt(true));

const external = Docker.Volume.lookup({ name: "shared-backup" });
```

Changing immutable volume configuration can require replacement and deletion of the previous physical volume. Alchemy refuses automatic destructive replacements of volumes adopted from another physical generation, including one labelled for the same stack. For data that must survive stack destruction or replacement, choose an explicit removal policy and maintain backups:

```typescript
import * as RemovalPolicy from "alchemy/RemovalPolicy";

const critical = yield* Docker.Volume("CriticalData").pipe(
  RemovalPolicy.protect(),
);
```

`protect()` blocks replacement and destruction; `retain()` preserves the physical volume when Alchemy forgets its state. Docker's name-only removal API cannot prevent every concurrent replacement race, so generation checks are not a substitute for backups. See the [Docker.Volume API reference](https://alchemy.run/providers/docker/reference/volume).

## Learn more

- [Docker on alchemy.run](https://alchemy.run/docker)
- [Setup](https://alchemy.run/docker/setup)
- [Build images](https://alchemy.run/docker/build-images)
- [API reference](https://alchemy.run/providers)
