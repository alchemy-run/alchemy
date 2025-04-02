# Document

The Document component allows you to manage AI-generated markdown documents using the Vercel AI SDK. It supports context handling through the Alchemy template literal tag. For more information, visit the [Vercel AI SDK documentation](https://vercel.com/docs/ai).

# Minimal Example

```ts
import { Document } from "alchemy/ai";

const apiDocs = await Document("api-docs", {
  title: "API Documentation",
  path: "./docs/api.md",
  prompt: await alchemy`
    Generate API documentation based on these source files:
    ${alchemy.file("src/api.ts")}
    ${alchemy.file("src/types.ts")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```

# Create the Document

```ts
import { Document } from "alchemy/ai";

const techDocs = await Document("tech-specs", {
  title: "Technical Specifications",
  path: "./docs/tech-specs.md",
  prompt: await alchemy`
    Create detailed technical specifications based on these requirements:
    ${alchemy.file("requirements/system.md")}
  `,
  model: {
    id: "o3-mini",
    provider: "openai",
    options: {
      reasoningEffort: "high"
    }
  },
  temperature: 0.1
});
```