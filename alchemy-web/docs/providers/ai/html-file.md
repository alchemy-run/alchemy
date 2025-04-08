# HTMLFile

The HTMLFile resource lets you generate HTML files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Creates a basic HTML file with AI-generated content.

```ts
import { HTMLFile } from "alchemy/ai";

const page = await HTMLFile("landing", {
  path: "./public/index.html",
  prompt: "Generate a simple landing page with a hero section and call-to-action button"
});
```

# Create an HTML Component

Generates a reusable HTML component with specific functionality.

```ts
import { HTMLFile } from "alchemy/ai";

const nav = await HTMLFile("navigation", {
  path: "./components/nav.html", 
  prompt: await alchemy`
    Create a responsive navigation component with:
    - Logo in the left corner
    - Navigation links: Home, Products, About, Contact
    - Mobile hamburger menu
    - Login/signup buttons
    
    Use the styling from:
    ${alchemy.file("src/styles/theme.css")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  },
  temperature: 0.2
});
```