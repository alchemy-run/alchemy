# AI Gateway

The AI Gateway resource lets you create and manage [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) configurations for your account. AI Gateway is a central place to manage AI model inference requests with features for authentication, rate limiting, caching, and logging.

## Minimal Example

Create a basic AI Gateway with default settings:

```ts
import { AiGateway } from "alchemy/cloudflare";

const basicGateway = await AiGateway("my-ai-gateway", {});
```

## With Authentication and Rate Limiting

Create an AI Gateway with authentication and rate limiting:

```ts
import { AiGateway } from "alchemy/cloudflare";

const secureGateway = await AiGateway("secure-ai-gateway", {
  authentication: true,
  rateLimitingInterval: 60, // 60 seconds
  rateLimitingLimit: 100,   // 100 requests per interval
  rateLimitingTechnique: "sliding"
});
```

## With Logging and Logpush

Create an AI Gateway with logging and logpush enabled:

```ts
import { AiGateway } from "alchemy/cloudflare";
import { alchemy } from "alchemy";

const loggingGateway = await AiGateway("logging-ai-gateway", {
  collectLogs: true,
  logpush: true,
  logpushPublicKey: alchemy.secret("AI_GATEWAY_PUBLIC_KEY")
});
```

## With Cache Configuration

Create an AI Gateway with caching enabled:

```ts
import { AiGateway } from "alchemy/cloudflare";

const cachingGateway = await AiGateway("caching-ai-gateway", {
  cacheInvalidateOnUpdate: true,
  cacheTtl: 300 // 5 minutes
});
```

## Bind to a Worker

Use an AI Gateway with a Cloudflare Worker:

```ts
import { AiGateway, Worker } from "alchemy/cloudflare";

const aiGateway = await AiGateway("my-ai-gateway", {
  authentication: true,
  rateLimitingInterval: 60,
  rateLimitingLimit: 100
});

const aiWorker = await Worker("ai-proxy-worker", {
  entry: "./src/worker.ts",
  bindings: {
    AI_GATEWAY: aiGateway
  }
});
``` 