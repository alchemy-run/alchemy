# Approve

The Approve resource lets you use AI to make approval decisions on content based on specific criteria.

# Minimal Example

Creates an approval decision for content based on a prompt.

```ts
import { Approve } from "alchemy/ai";

const result = await Approve("code-approval", {
  content: "function add(a,b) { return a + b }",
  prompt: "Approve this code if it follows best practices"
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
  content: "This is the content to review",
  prompt: "Approve this documentation if it is clear and accurate",
  messages: [
    { role: "user", content: "Can you review this documentation?" },
    { role: "assistant", content: "Yes, I'd be happy to review it." },
    { role: "user", content: "Please check for clarity and accuracy." }
  ],
  temperature: 0.2
});
```

# Create an Approval with Custom System Prompt

```ts
import { Approve } from "alchemy/ai";

const result = await Approve("security-approval", {
  content: await alchemy`
    Review this code for security:
    ${alchemy.file("src/api.ts")}
  `,
  prompt: "Approve only if there are no security vulnerabilities",
  system: "You are a security expert. Carefully analyze code for security issues. Be strict and thorough in your assessment.",
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```