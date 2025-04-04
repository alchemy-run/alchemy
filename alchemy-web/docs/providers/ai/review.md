# Review

The Review resource uses AI models to provide detailed feedback and analysis of content using the [Vercel AI SDK](https://sdk.vercel.ai/docs).

# Minimal Example

Creates a review of code or content with detailed feedback and suggestions.

```ts
import { Review } from "alchemy/ai";

const codeReview = await Review("api-review", {
  content: await alchemy`
    Review this API implementation:
    ${alchemy.file("src/api.ts")}
  `,
  prompt: "Review this API implementation for security vulnerabilities, performance issues, and best practices."
});
```

# Create a Review with Message History

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
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```