# CSSFile

The CSSFile resource lets you generate CSS files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Generate a simple CSS file with basic styles.

```ts
import { CSSFile } from "alchemy/ai";

const styles = await CSSFile("main-styles", {
  path: "./styles/main.css",
  prompt: "Generate modern CSS styles with a primary color of #0062ff and responsive layout"
});
```

# Create Component Styles

Generate CSS styles for a specific component with hover effects and animations.

```ts
import { CSSFile } from "alchemy/ai";

const cardStyles = await CSSFile("card-styles", {
  path: "./components/Card.css",
  prompt: await alchemy`
    Create CSS styles for this HTML component:
    ${alchemy.file("src/components/Card.html")}
    
    Include:
    - Hover effects and transitions
    - Light/dark theme support
    - CSS variables for colors
  `,
  temperature: 0.2
});
```