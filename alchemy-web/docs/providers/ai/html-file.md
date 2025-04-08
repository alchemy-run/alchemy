# HTMLFile

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

# Create an HTML File with Context

Generates HTML using existing files and templates as context.

```ts
import { HTMLFile } from "alchemy/ai";

const component = await HTMLFile("nav", {
  path: "./components/nav.html", 
  prompt: await alchemy`
    Create a navigation component following the style from:
    ${alchemy.file("src/templates/base.html")}
    
    Include:
    - Logo
    - Navigation links
    - Mobile menu
    - Search bar
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  },
  temperature: 0.2
});
```