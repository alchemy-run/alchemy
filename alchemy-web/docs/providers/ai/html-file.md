# HTML File

The HTML File resource lets you generate HTML files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Generate a simple HTML file with AI.

```ts
import { HTMLFile } from "alchemy/ai";

const page = await HTMLFile("landing", {
  path: "./public/index.html",
  prompt: "Create a simple landing page with a hero section and call-to-action button"
});
```

# Create an HTML File with Context

Use template literals to include file context in the prompt.

```ts
import { HTMLFile } from "alchemy/ai";

const component = await HTMLFile("user-card", {
  path: "./components/UserCard.html", 
  prompt: await alchemy`
    Create an HTML component using the styles from:
    ${alchemy.file("src/styles/card.css")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```

# Generate HTML with Custom System Prompt

Customize the model's behavior with a system prompt.

```ts
import { HTMLFile } from "alchemy/ai";

const form = await HTMLFile("contact-form", {
  path: "./components/ContactForm.html",
  prompt: "Create a contact form with name, email, message fields and validation",
  system: "You are an HTML expert specializing in accessible forms. Create semantic HTML with ARIA attributes.",
  temperature: 0.2
});
```