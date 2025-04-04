# Document

The Document Resource lets you generate markdown documentation using AI models like [OpenAI GPT-4](https://openai.com/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Generate a markdown document from a prompt.

```ts
import { Document } from "alchemy/ai";

const docs = await Document("api-docs", {
  title: "API Documentation",
  prompt: "Generate API documentation for a REST API"
});
```

# Create a Document with File Context

Use alchemy template literals to include file context in the prompt.

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

# Create a Document with Message History

Use message history for iterative document generation.

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