# Document

The Document resource lets you generate markdown documentation using [AI models](https://platform.openai.com/docs/models) like GPT-4 and Claude.

## Minimal Example

Generate a simple markdown document with AI:

```ts
import { Document } from "alchemy/ai";

const docs = await Document("api-docs", {
  path: "./docs/api.md",
  prompt: await alchemy`
    Generate API documentation based on:
    ${alchemy.file("src/api.ts")}
  `
});
```

## Using Message History

Generate documentation through a conversation:

```ts
import { Document } from "alchemy/ai";

const docs = await Document("api-docs", {
  path: "./docs/api.md", 
  messages: [
    { role: "user", content: "Generate API documentation" },
    { role: "assistant", content: "I'll help create the docs. What API should I document?" },
    { role: "user", content: "Document the user management API in src/api.ts" }
  ],
  system: "You are a technical writer specializing in API documentation."
});
```

## Custom Model Configuration

Use specific AI models and parameters:

```ts
import { Document } from "alchemy/ai";

const docs = await Document("api-docs", {
  path: "./docs/api.md",
  prompt: "Generate API documentation...",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic",
    options: {
      temperature: 0.2
    }
  }
});
```

## Freezing Documents

Prevent regeneration on subsequent runs:

```ts
import { Document } from "alchemy/ai";

const docs = await Document("api-docs", {
  path: "./docs/api.md",
  prompt: "Generate API documentation...",
  freeze: true // Document won't be regenerated on updates
});
```