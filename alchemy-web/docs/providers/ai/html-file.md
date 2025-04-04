# HTML File

The HTMLFile resource lets you generate HTML files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Generate a simple HTML file with AI.

```ts
import { HTMLFile } from "alchemy/ai";

const page = await HTMLFile("landing-page", {
  path: "./public/index.html",
  prompt: "Generate a modern landing page with a hero section, features list, and contact form"
});
```

# Create an HTML File with Context

```ts
import { HTMLFile } from "alchemy/ai";

const component = await HTMLFile("nav-component", {
  path: "./components/nav.html", 
  prompt: await alchemy`
    Create a responsive navigation component using:
    ${alchemy.file("src/styles/theme.css")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```

# Generate HTML with Custom System Prompt

```ts
import { HTMLFile } from "alchemy/ai";

const form = await HTMLFile("contact-form", {
  path: "./components/form.html",
  prompt: "Create an accessible contact form with validation",
  system: "You are an accessibility expert. Generate semantic HTML that follows WCAG guidelines.",
  temperature: 0.2
});
```