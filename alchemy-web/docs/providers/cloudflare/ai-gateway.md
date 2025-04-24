# AiGateway

The AiGateway component lets you create and manage [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) configurations.

# Minimal Example

Create a basic AI Gateway with default settings:

```ts
import { AiGateway } from "alchemy/cloudflare";

const gateway = await AiGateway("my-ai-gateway", {});
```

# With Authentication and Rate Limiting

Create an AI Gateway with authentication and rate limiting:

```ts
import { AiGateway } from "alchemy/cloudflare";

const secureGateway = await AiGateway("secure-ai-gateway", {
  authentication: true,
  rateLimitingInterval: 60, // 60 seconds
  rateLimitingLimit: 100,   // 100 requests
  rateLimitingTechnique: "sliding"
});
```

# With Logging and Logpush

Create an AI Gateway with logging enabled and logpush:

```ts
import { AiGateway } from "alchemy/cloudflare";

const loggingGateway = await AiGateway("logging-ai-gateway", {
  collectLogs: true,
  logpush: true,
  logpushPublicKey: "mypublickey..." // Replace with actual public key
});
```

# Bind to a Worker

Use the AI Gateway in a Cloudflare Worker:

```ts
import { Worker, AiGateway } from "alchemy/cloudflare";

const gateway = await AiGateway("my-gateway", {
  authentication: true
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    AI: gateway
  }
});
```