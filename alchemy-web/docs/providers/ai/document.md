# Document Resource

The Document Resource lets you generate markdown documentation using AI models like OpenAI's GPT-4 and Anthropic's Claude.

# Minimal Example

Creates a simple markdown document with AI-generated content.

```ts
import { Document } from "alchemy/ai";

const doc = await Document("api-docs", {
  title: "API Documentation",
  prompt: "Generate API documentation for a REST API"
});
```

# Create a Document with File Context

```ts
import { Document } from "alchemy/ai";

const apiDocs = await Document("api-docs", {
  title: "API Documentation", 
  path: "./docs/api.md",
  prompt: await alchemy`
    Generate API documentation based on these source files:
    ${alchemy.file("src/api.ts")}
    ${alchemy.file("src/types.ts")}
  `
});
```

# Generate Documentation with Message History

```ts
import { Document } from "alchemy/ai";

const apiDocs = await Document("api-docs", {
  title: "API Documentation",
  messages: [
    { role: "user", content: "Create API documentation for these files" },
    { role: "assistant", content: "I'll help you create API documentation. Please provide the files." },
    { role: "user", content: "Here are the files: [file contents]" }
  ],
  system: "You are a technical documentation writer. Generate clear and concise API documentation."
});
```

# Configure Model and Generation Parameters

```ts
import { Document } from "alchemy/ai";

const techDocs = await Document("tech-specs", {
  title: "Technical Specifications",
  path: "./docs/tech-specs.md",
  prompt: await alchemy`
    Create detailed technical specifications based on:
    ${alchemy.file("requirements/system.md")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai",
    options: {
      temperature: 0.2,
      maxTokens: 8192
    }
  }
});
```