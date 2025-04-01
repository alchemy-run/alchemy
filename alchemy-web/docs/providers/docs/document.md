# Document

The Document resource allows you to create, update, and manage markdown documents using AI-generated content. It leverages the Vercel AI SDK for content generation, supporting context handling through Alchemy template literals. For more information, visit the [Vercel AI SDK documentation](https://vercel.com/docs/ai).

# Minimal Example

```ts twoslash
import { Document } from "alchemy/docs";

const apiDocs = await Document("api-docs", {
  path: "./docs/api.md",
  prompt: "Generate API documentation based on the source files.",
  apiKey: alchemy.secret(process.env.OPENAI_API_KEY),
});
```

# Create the Document

```ts twoslash
import { Document } from "alchemy/docs";

const modelDocs = await Document("models", {
  path: "./docs/models.md",
  prompt: await alchemy`
    Write documentation for these data models:
    ${alchemy.files("src/models/user.ts", "src/models/post.ts")}
  `,
  apiKey: alchemy.secret(process.env.OPENAI_API_KEY),
  model: {
    id: "gpt-4o",
    provider: "openai",
  },
});
```