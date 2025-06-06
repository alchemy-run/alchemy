---
title: Managing Cloudflare Workers AI with Alchemy
description: Learn how to use Cloudflare Workers AI binding with Alchemy to run machine learning models on Cloudflare's global network.
---

# AI

The AI binding lets you run machine learning models using [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) directly from your Workers.

## Minimal Example

Create a basic AI binding for text generation:

```ts
import { Worker, Ai } from "alchemy/cloudflare";

const ai = new Ai();

await Worker("ai-worker", {
  name: "ai-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    AI: ai
  }
});
```

## Text Generation

Use AI models for text generation tasks:

```ts
import { Worker, Ai } from "alchemy/cloudflare";

const ai = new Ai();

await Worker("text-generator", {
  name: "text-generator",
  entrypoint: "./src/text.ts",
  bindings: {
    AI: ai
  }
});
```

Worker implementation:

```ts
// src/text.ts
export default {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: "What is the capital of France?"
    });
    
    return new Response(JSON.stringify(response));
  }
};
```

## Text Embeddings

Generate embeddings for semantic search and similarity:

```ts
import { Worker, Ai } from "alchemy/cloudflare";

const ai = new Ai();

await Worker("embeddings-worker", {
  name: "embeddings-worker",
  entrypoint: "./src/embeddings.ts",
  bindings: {
    AI: ai
  }
});
```

Worker implementation:

```ts
// src/embeddings.ts
export default {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    const response = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["Hello world", "Goodbye world"]
    });
    
    return new Response(JSON.stringify(response));
  }
};
```

## Image Classification

Classify images using computer vision models:

```ts
import { Worker, Ai } from "alchemy/cloudflare";

const ai = new Ai();

await Worker("image-classifier", {
  name: "image-classifier",
  entrypoint: "./src/image.ts",
  bindings: {
    AI: ai
  }
});
```

Worker implementation:

```ts
// src/image.ts
export default {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    const imageArrayBuffer = await request.arrayBuffer();
    
    const response = await env.AI.run("@cf/microsoft/resnet-50", {
      image: imageArrayBuffer
    });
    
    return new Response(JSON.stringify(response));
  }
};
```

## With AI Gateway

Combine AI binding with AI Gateway for observability and control:

```ts
import { Worker, Ai, AiGateway } from "alchemy/cloudflare";

const aiGateway = await AiGateway("my-gateway", {
  name: "my-ai-gateway"
});

const ai = new Ai();

await Worker("gateway-ai-worker", {
  name: "gateway-ai-worker",
  entrypoint: "./src/gateway.ts",
  bindings: {
    AI: ai,
    GATEWAY: aiGateway
  }
});
```

Worker implementation with gateway:

```ts
// src/gateway.ts
export default {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: "Explain quantum computing"
    }, {
      gateway: {
        id: "my-ai-gateway",
        cacheKey: "quantum-explanation",
        cacheTtl: 3600
      }
    });
    
    return new Response(JSON.stringify(response));
  }
};
```

## Available Models

Workers AI supports 50+ models across different categories:

- **Text Generation**: Llama, Mistral, Qwen, and more
- **Text Embeddings**: BGE models for semantic search
- **Image Classification**: ResNet, object detection models
- **Text-to-Image**: Stable Diffusion variants
- **Speech Recognition**: Whisper models
- **Translation**: M2M100 for multilingual translation

## Runtime Usage

The AI binding provides several methods in your Worker runtime:

### `run(model, inputs, options?)`

Run inference on a specific model:

```ts
const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
  prompt: "Your prompt here"
}, {
  gateway: { id: "my-gateway" }
});
```

### `models(params?)`

List available models:

```ts
const models = await env.AI.models();
```

### `gateway(gatewayId)`

Get AI Gateway instance:

```ts
const gateway = env.AI.gateway("my-gateway-id");
```

## TypeScript Support

For full type safety, you can specify model types:

```ts
import { Worker, Ai, type } from "alchemy/cloudflare";

interface MyAiModels {
  "@cf/meta/llama-3.1-8b-instruct": {
    inputs: { prompt: string };
    postProcessedOutputs: { response: string };
  };
}

const ai = new Ai<MyAiModels>();
```

## Bind to a Worker

```ts
import { Worker, Ai } from "alchemy/cloudflare";

const ai = new Ai();

await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    AI: ai
  }
});
```

## Links

- [Cloudflare Workers AI Documentation](https://developers.cloudflare.com/workers-ai/)
- [Available Models](https://developers.cloudflare.com/workers-ai/models/)
- [AI Gateway Integration](https://developers.cloudflare.com/workers-ai/get-started/workers-ai-gateway/)
- [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
