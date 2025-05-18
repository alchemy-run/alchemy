---
title: Docker Provider
description: Deploy and manage Docker resources using Alchemy
---

# Docker Provider

The Docker provider allows you to create, manage, and orchestrate Docker resources directly from your Alchemy applications. With this provider, you can pull images, run containers, create networks, and more, all using the familiar Alchemy Resource syntax.

## Resources

The Docker provider includes the following resources:

- [DockerRemoteImage](./remote-image.md) - Pull and manage Docker images
- [DockerContainer](./container.md) - Run and manage Docker containers
- [DockerNetwork](./network.md) - Create and manage Docker networks

## Example

Here's a simple example of using the Docker provider to create a web application with Redis:

```typescript
import { DockerContainer, DockerRemoteImage, DockerNetwork } from "alchemy/docker";

// Create a Docker network
const network = await DockerNetwork("app-network", {
  name: "my-application-network"
});

// Pull Redis image
const redisImage = await DockerRemoteImage("redis-image", {
  name: "redis",
  tag: "alpine"
});

// Run Redis container
const redis = await DockerContainer("redis", {
  image: redisImage.imageRef,
  name: "redis",
  networks: [{ name: network.name }],
  start: true
});

// Pull the application image
const appImage = await DockerRemoteImage("app-image", {
  name: "node",
  tag: "16-alpine"
});

// Run the application container
const app = await DockerContainer("app", {
  image: appImage.imageRef,
  name: "web-app",
  ports: [{ external: 3000, internal: 3000 }],
  networks: [{ name: network.name }],
  environment: {
    REDIS_HOST: "redis",
    NODE_ENV: "production"
  },
  start: true
});

// Output the URL
export const url = `http://localhost:3000`;
```

## Additional Resources

For more complex examples, see the [Docker Example](https://github.com/sam-goodwin/alchemy/tree/main/examples/docker-example) in the Alchemy repository.
