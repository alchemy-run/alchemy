# Document

The Document resource generates markdown documentation using AI models like OpenAI's GPT-4 and Anthropic's Claude. It supports powerful context handling through the alchemy template literal tag.

# Minimal Example

Generate a simple markdown document with AI:

```ts
import { Document } from "alchemy/ai";

const docs = await Document("api-docs", {
  title: "API Documentation",
  prompt: "Generate API documentation for a REST API with endpoints for users, posts and comments",
  path: "./docs/api.md"
});
```

# Generate Documentation from Source Files

Use alchemy template literals to include file context:

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

# Iterative Document Generation with Message History

Use message history for conversation-based generation:

```ts
import { Document } from "alchemy/ai";

const apiDocs = await Document("api-docs", {
  title: "API Documentation",
  path: "./docs/api.md",
  messages: [
    { role: "user", content: "Create API documentation for these files" },
    { role: "assistant", content: "I'll help you create API documentation. Please provide the files." },
    { role: "user", content: "Here are the files: [file contents]" }
  ],
  system: "You are a technical documentation writer. Generate clear and concise API documentation.",
  temperature: 0.2
});
```