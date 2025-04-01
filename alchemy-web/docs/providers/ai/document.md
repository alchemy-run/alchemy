# Document

The Document resource allows you to create, update, and manage markdown documents using AI-generated content. It leverages the Vercel AI SDK to generate content based on a given prompt and context. This resource is ideal for generating documentation, reports, or any markdown-based content. For more information, visit the [Vercel AI SDK documentation](https://vercel.com/docs/ai).

# Minimal Example

```ts
import { Document } from "alchemy/ai";

const doc = await Document("example-doc", {
  title: "Example Document",
  path: "./docs/example.md",
  prompt: "Generate a simple example document.",
  apiKey: alchemy.secret(process.env.OPENAI_API_KEY),
});
```

# Create the Document

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
  apiKey: alchemy.secret(process.env.OPENAI_API_KEY),
  model: {
    id: "gpt-4o",
    provider: "openai",
  },
});
```

This example demonstrates how to create a markdown document using the Document resource. It uses the alchemy template literals to include file context in the prompt, allowing for dynamic content generation based on the specified source files.