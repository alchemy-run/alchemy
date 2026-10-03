---
title: Docker.Container reference
description: Resources and capabilities for Docker.Container.
head:
  - tag: meta
    attrs:
      name: robots
      content: "noindex, follow"
prev: false
next: false
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

## Container

> **Source:** `src/Docker/Container.ts`

A Docker container managed through the active Docker context.

This resource creates, starts, stops, inspects, and removes containers through
the Docker CLI. It is not interchangeable with `Cloudflare.Container`, which
manages Cloudflare's container platform; use pushed image references to bridge
Docker-built images into cloud container runtimes.

### Container: Running Containers

```typescript
const nginx = yield* Docker.Container("nginx", {
  image: "nginx:alpine",
  ports: [{ external: 8080, internal: 80 }],
  start: true,
});
```

### Container: Secret Environment

```typescript
const password = yield* Config.Redacted("POSTGRES_PASSWORD");
const db = yield* Docker.Container("postgres", {
  image: "postgres:18-alpine",
  environment: {
    POSTGRES_PASSWORD: password,
  },
  start: true,
});
```

### Container: Environment Files

```typescript
const app = yield* Docker.Container("app", {
  image: "ghcr.io/acme/app:latest",
  envFiles: ["./config/base.env", "./config/production.env"],
  // Explicit values are passed after env files and take precedence.
  environment: { LOG_LEVEL: "info" },
});
```

Alchemy does not read or hash env file contents, so changing a file in place
does not replace the container. Docker resolves the files and may persist
and expose their resulting values through Docker inspect. The normalized
Container attributes omit `Config.Env`, so those values are not written to
Alchemy resource-state attributes by this resource, but Docker daemon access
can still reveal them. Treat env files as potentially secret. Use a changed
or versioned path when a file change should trigger replacement.

### Container: Networks and Volumes

```typescript
const network = yield* Docker.Network("app-network");
const data = yield* Docker.Volume("postgres-data");
const postgresName = "app-postgres";
yield* Docker.Container("postgres", {
  name: postgresName,
  image: "postgres:18-alpine",
  ports: [{ external: 15432, internal: 5432 }],
  volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql/data" }],
  networks: [{ name: network.name, aliases: ["postgres"] }],
  start: true,
});
const runtime = yield* Docker.inspectContainer(postgresName);
```

### Container: Host Access

`extraHosts` writes lines into the container's `/etc/hosts`; it changes name
resolution and nothing else. Docker's `host-gateway` alias resolves to the
host machine, which is how a container reaches a service on the developer's
loopback.

On Linux `host-gateway` is the Docker bridge gateway (typically
`172.17.0.1`), so a container's packets to it arrive on the host's `INPUT`
chain. Under a default-deny firewall — ufw ships
`DEFAULT_INPUT_POLICY="DROP"` — the hostname resolves correctly and the
connection then times out, which reads like an application bug rather than a
firewall one. Allow the bridge subnet to fix it:
`sudo ufw allow from 172.16.0.0/12`.

**Reach a service on the developer's machine**

```typescript
const api = yield* Docker.Container("api", {
  image: "ghcr.io/acme/api:latest",
  // `host-gateway` resolves to the host machine, so a database listening
  // on the developer's loopback is reachable from inside the container.
  extraHosts: ["host.docker.internal:host-gateway"],
  environment: {
    DATABASE_URL: "postgres://postgres@host.docker.internal:5432/app",
  },
  start: true,
});
```

**Pin a hostname to a fixed address**

```typescript
const api = yield* Docker.Container("api", {
  image: "ghcr.io/acme/api:latest",
  // Any `hostname:address` pair — host access is just the common case.
  extraHosts: ["service.example:192.0.2.10"],
  start: true,
});
```

**Publish on any free host port**

```typescript
const api = yield* Docker.Container("api", {
  image: "ghcr.io/acme/api:latest",
  // `external: 0` lets Docker choose; the assigned port is reported back.
  ports: [{ external: 0, internal: 3000 }],
  start: true,
});
const hostPort = api.ports["3000/tcp"];
```

### Container: Traefik

**Route a container through Traefik**

```typescript
const api = yield* Docker.Container("api", {
  image: "ghcr.io/acme/api:latest",
  networks: [{ name: "traefik" }],
  labels: {
    "traefik.enable": "true",
    "traefik.http.routers.api.rule": "Host(`api.example.com`)",
    "traefik.http.services.api.loadbalancer.server.port": "3000",
  },
  stopTimeout: "30 seconds",
  start: true,
});
```

**Use a Docker.Context resource**

```typescript
const remote = yield* Docker.Context("remote", {
  name: "remote-build",
  docker: "host=ssh://docker@example.com",
});

const api = yield* Docker.Container("api", {
  image: "nginx:alpine",
  context: remote,
});
```

