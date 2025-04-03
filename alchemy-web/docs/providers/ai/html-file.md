# HTML File

The HTMLFile resource lets you generate HTML files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Creates a basic HTML file with AI-generated content.

```ts
import { HTMLFile } from "alchemy/ai";

const page = await HTMLFile("landing", {
  path: "./public/index.html",
  prompt: "Generate a simple landing page with a hero section, features list, and contact form"
});
```

# Create an HTML File with Custom Configuration

```ts
import { HTMLFile } from "alchemy/ai";

const emailTemplate = await HTMLFile("welcome-email", {
  path: "./emails/welcome.html", 
  prompt: await alchemy`
    Create an HTML email template with:
    - Company logo and branding
    - Welcome message with {{name}} placeholder
    - Getting started steps
    - Support contact info
    - Unsubscribe footer
  `,
  system: "You are an email template expert. Create responsive HTML that works across email clients.",
  model: {
    id: "gpt-4o",
    provider: "openai",
    options: {
      temperature: 0.2
    }
  }
});
```