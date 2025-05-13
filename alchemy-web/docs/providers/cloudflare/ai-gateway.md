---
title: Managing Cloudflare AI Gateway with Alchemy
description: Learn how to create and configure Cloudflare AI Gateway using Alchemy to route and manage AI requests.
---

# AiGateway

The AiGateway resource lets you create and manage [Cloudflare AI Gateway](https://developers.cloudflare.com/workers-ai/get-started/workers-ai-gateway/) configurations for accessing AI models through Cloudflare Workers.

## Minimal Example

Create a basic AI Gateway with default settings:

```ts
import { AiGateway } from "alchemy/cloudflare";

const gateway = await AiGateway("my-ai-gateway", {
  name: "my-ai-gateway"
});
```

## With Authentication and Rate Limiting

Configure an AI Gateway with authentication and rate limiting:

```ts
import { AiGateway } from "alchemy/cloudflare";

const secureGateway = await AiGateway("secure-gateway", {
  name: "secure-gateway",
  authentication: true,
  rateLimitingInterval: 60,
  rateLimitingLimit: 100,
  rateLimitingTechnique: "sliding"
});
```

## With Logging and Logpush

Create an AI Gateway with logging and logpush enabled:

```ts
import { AiGateway } from "alchemy/cloudflare";

const loggingGateway = await AiGateway("logging-gateway", {
  name: "logging-gateway",
  collectLogs: true,
  logpush: true,
  logpushPublicKey: "mypublickey..."
});
```

## Bind to a Worker

Use the AI Gateway in a Cloudflare Worker:

```ts
import { Worker, AiGateway } from "alchemy/cloudflare";

const gateway = await AiGateway("my-gateway", {
  name: "my-gateway"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    AI: gateway
  }
});
```