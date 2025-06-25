---
title: Container
description: Deploy Docker containers on Cloudflare's global network
---

# Container

Run Docker containers on Cloudflare's global network with automatic scaling and global distribution.

## Container Binding

Bind containers to Workers for containerized Durable Objects:

```typescript
import { Container, Worker } from "alchemy/cloudflare";
import { Image } from "alchemy/docker";

const image = await Image("container-do", {
  build: {
    dockerfile: "./Dockerfile.container",
  },
});

const container = new Container("my-container", {
  image,
  className: "MyContainerClass",
});

const worker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    MY_CONTAINER: container,
  },
});
```
