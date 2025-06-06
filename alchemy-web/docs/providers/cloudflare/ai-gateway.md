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

## Complete Worker Example with AI Model Usage

Here's a complete example showing how to use AI Gateway in a Cloudflare Worker to interact with AI models:

```ts
import { Worker, AiGateway } from "alchemy/cloudflare";

// Create an AI Gateway with rate limiting and logging
const aiGateway = await AiGateway("chat-gateway", {
  rateLimitingInterval: 60,
  rateLimitingLimit: 100,
  rateLimitingTechnique: "sliding",
  collectLogs: true,
  cacheTtl: 300 // Cache responses for 5 minutes
});

// Create a Worker that uses the AI Gateway
await Worker("chat-worker", {
  script: `
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const { message } = await request.json();
      
      if (!message) {
        return new Response("Message is required", { status: 400 });
      }

      // Use the AI Gateway to run inference
      const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that provides concise, accurate responses."
          },
          {
            role: "user", 
            content: message
          }
        ],
        max_tokens: 256,
        temperature: 0.7
      });

      return new Response(JSON.stringify({
        success: true,
        response: response.response,
        usage: response.usage
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });

    } catch (error) {
      console.error("AI Gateway error:", error);
      
      return new Response(JSON.stringify({
        success: false,
        error: "Failed to process AI request"
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};`,
  bindings: {
    AI: aiGateway
  }
});
```

### Key Features Demonstrated

- **Rate Limiting**: The gateway limits requests to 100 per minute using a sliding window
- **Caching**: Responses are cached for 5 minutes to improve performance
- **Logging**: All requests are logged for monitoring and debugging
- **Error Handling**: Proper error handling for AI model failures
- **CORS Support**: Cross-origin requests are supported for web applications
- **Model Usage**: Shows how to call Llama 3.1 8B Instruct model through the gateway

### Testing the Worker

You can test the deployed worker with a simple curl command:

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"message": "What is the capital of France?"}'
```

The AI Gateway will handle rate limiting, caching, and logging automatically while your worker focuses on the application logic.
