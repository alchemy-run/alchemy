# Document

The Document component allows you to create, update, and manage markdown documents using AI-generated content. It leverages the Vercel AI SDK for content generation, supporting context handling through Alchemy template literals.

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