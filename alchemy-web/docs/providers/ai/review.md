# Review

The Review Resource lets you generate AI-powered reviews of content using [Vercel AI SDK](https://sdk.vercel.ai/docs).

# Minimal Example

Creates a basic review of content with default settings.

```ts
import { Review } from "alchemy/ai";

const review = await Review("code-review", {
  content: "function add(a,b) { return a + b }",
  prompt: "Review this code for best practices"
});
```

# Create a Code Review

```ts
import { Review } from "alchemy/ai";

const codeReview = await Review("api-review", {
  content: await alchemy`
    Review this API implementation:
    ${alchemy.file("src/api.ts")}
  `,
  prompt: "Review this API for security vulnerabilities, performance issues, and best practices",
  model: {
    id: "gpt-4o",
    provider: "openai"
  },
  temperature: 0.2
});
```

# Review with Message History

```ts
import { Review } from "alchemy/ai";

const reviewWithHistory = await Review("code-review-iteration-2", {
  content: "Updated code implementation",
  prompt: "Review this updated implementation",
  messages: [
    { role: "user", content: "Can you review my code?" },
    { role: "assistant", content: "I'll review your code. Please share it." },
    { role: "user", content: "Here's my implementation: [code]" },
    { role: "assistant", content: "Here's my review of your code: [previous review]" }
  ],
  system: "You are a senior software engineer reviewing code changes"
});
```