# CSS File

The CSS File resource lets you generate CSS code using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Creates a CSS file with AI-generated styles based on a prompt.

```ts
import { CSSFile } from "alchemy/ai";

const styles = await CSSFile("main-styles", {
  path: "./public/css/main.css",
  prompt: "Generate modern CSS styles for a company website with clean, minimalist design"
});
```

# Create CSS with Context

```ts
import { CSSFile } from "alchemy/ai";

const componentStyles = await CSSFile("component-styles", {
  path: "./src/styles/component.css",
  prompt: await alchemy`
    Create CSS styles for this HTML component:
    ${alchemy.file("src/components/Card.html")}
    
    The styles should:
    - Be modern and clean
    - Include hover effects
    - Support light/dark themes
    - Use CSS variables
  `,
  temperature: 0.2
});
```