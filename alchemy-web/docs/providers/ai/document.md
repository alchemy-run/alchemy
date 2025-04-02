# Document

The Document resource allows you to create, update, and manage markdown documents using AI-generated content. It leverages the Vercel AI SDK for generating content based on provided prompts and file contexts. This resource is ideal for generating documentation with dynamic content and context-aware prompts.

# Minimal Example

```ts
import { Document } from "alchemy/ai";

const apiDocs = await Document("api-docs", {
  path: "./docs/api.md",
  prompt: await alchemy`
    Generate API documentation based on these source files:
    ${alchemy.file("src/api.ts")}
    ${alchemy.file("src/types.ts")}
  `
});
```

# Create the Document

```ts
import { Document } from "alchemy/ai";

const modelDocs = await Document("models", {
  path: "./docs/models.md",
  prompt: await alchemy`
    Write documentation for these data models:
    ${alchemy.files("src/models/user.ts", "src/models/post.ts")}
  `
});
```