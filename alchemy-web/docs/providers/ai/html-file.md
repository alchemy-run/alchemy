# HTMLFile

The HTMLFile resource generates HTML files using AI models like OpenAI's GPT-4 or Anthropic's Claude. It extracts HTML code from between ```html fences and validates the response.

## Minimal Example

Creates a basic HTML file with AI-generated content.

```ts
import { HTMLFile } from "alchemy/ai";

const page = await HTMLFile("landing", {
  path: "./public/index.html",
  prompt: "Generate a simple landing page with a hero section, features list, and contact form"
});
```

## With Custom System Prompt

Provides specific instructions to the AI model about how to generate the HTML.

```ts
import { HTMLFile } from "alchemy/ai";

const nav = await HTMLFile("nav", {
  path: "./components/nav.html", 
  prompt: "Create a responsive navigation menu with dropdown support",
  system: "You are an expert HTML developer specializing in semantic markup and accessibility. Create a single HTML file with no additional text."
});
```

## With Model Configuration

Specifies which AI model to use and its configuration options.

```ts
import { HTMLFile } from "alchemy/ai";

const form = await HTMLFile("contact-form", {
  path: "./components/form.html",
  prompt: "Generate an accessible contact form with validation",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  },
  temperature: 0.2
});
```

## With File Context

Uses existing files as context for generating new HTML.

```ts
import { HTMLFile } from "alchemy/ai";

const card = await HTMLFile("product-card", {
  path: "./components/card.html",
  prompt: await alchemy`
    Create a product card component following the style of:
    ${alchemy.file("src/components/base-card.html")}
  `
});
```