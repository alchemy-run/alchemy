# HTML File

The HTMLFile component allows you to generate and manage HTML files using AI models. It extracts HTML code from AI-generated responses and ensures the content is valid and formatted. Learn more about HTML at [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTML).

# Minimal Example

```ts
import { HTMLFile } from "alchemy/ai";

const landingPage = await HTMLFile("landing-page", {
  path: "./public/index.html",
  prompt: "Generate a simple HTML page with a header, footer, and main content area.",
});
```

# Create the HTML File

```ts
import { HTMLFile } from "alchemy/ai";

const emailTemplate = await HTMLFile("welcome-email", {
  path: "./emails/welcome.html",
  prompt: `
    Create an HTML email template for welcoming new users.
    Include a company logo, welcome message, and contact information.
  `,
  system: "You are an HTML email template generator. Create a single HTML file inside ```html fences.",
  model: {
    id: "gpt-4o",
    provider: "openai"
  },
  temperature: 0.2
});
```