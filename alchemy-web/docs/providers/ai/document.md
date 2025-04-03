# Document

The Document resource allows you to create, update, and manage markdown documents using AI-generated content. It leverages AI models to generate structured markdown content based on a given prompt and system instructions. For more information, visit the [Alchemy Documentation](https://alchemy.example.com/docs).

# Minimal Example

```ts
import { Document } from "alchemy/ai";

const apiDocs = await Document("api-docs", {
  title: "API Documentation",
  path: "./docs/api.md",
  prompt: "Generate API documentation for the new endpoints.",
});
```

# Create the Document

```ts
import { Document } from "alchemy/ai";

const techSpecs = await Document("tech-specs", {
  title: "Technical Specifications",
  path: "./docs/tech-specs.md",
  prompt: "Create detailed technical specifications for the new system architecture.",
  system: "You are an expert technical writer specializing in system specifications. Create a single markdown document inside ```md fences with no additional text.",
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