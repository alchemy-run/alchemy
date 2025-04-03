# Document

The Document resource lets you generate markdown documentation using AI models like [OpenAI GPT-4](https://openai.com/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Creates a markdown document with AI-generated content.

```ts
import { Document } from "alchemy/ai";

const docs = await Document("api-docs", {
  title: "API Documentation",
  path: "./docs/api.md",
  prompt: "Generate API documentation for a REST API"
});
```

# Create Documentation with Context

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

# Advanced Configuration

```ts
import { Document } from "alchemy/ai";

const techDocs = await Document("tech-specs", {
  title: "Technical Specifications",
  path: "./docs/tech-specs.md",
  prompt: await alchemy`
    Create detailed technical specifications based on:
    ${alchemy.file("requirements/system.md")}
  `,
  system: "You are an expert technical writer specializing in system specifications.",
  model: {
    id: "claude-3-opus-20240229", 
    provider: "anthropic"
  },
  temperature: 0.1,
  maxTokens: 10000
});
```