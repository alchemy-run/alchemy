# Approve

The Approve resource uses AI models to make approval decisions based on provided content and criteria. It leverages the [Vercel AI SDK](https://sdk.vercel.ai/docs) for generating structured approval responses.

# Minimal Example

Makes an approval decision with explanation based on content and criteria.

```ts
import { Approve } from "alchemy/ai";

const result = await Approve("code-approval", {
  content: "Code to review...",
  prompt: "Approve if code follows security best practices"
});

if (result.approved) {
  console.log("Approved:", result.explanation);
} else {
  console.log("Denied:", result.explanation);
  console.log("Suggestions:", result.suggestions);
}
```

# Create an Approval with Message History

```ts
import { Approve } from "alchemy/ai";

const result = await Approve("doc-approval", {
  messages: [
    { role: "user", content: "Can you review this documentation?" },
    { role: "assistant", content: "Yes, I'll review it." },
    { role: "user", content: "Here's the content to review..." }
  ],
  system: "You are a technical documentation reviewer. Approve content that is clear, accurate and complete."
});
```

# Create an Approval with File Context

```ts
import { Approve } from "alchemy/ai";

const result = await Approve("api-approval", {
  content: await alchemy`
    Review this API implementation:
    ${alchemy.file("src/api.ts")}
  `,
  prompt: "Approve if the API follows REST best practices and has proper error handling",
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```