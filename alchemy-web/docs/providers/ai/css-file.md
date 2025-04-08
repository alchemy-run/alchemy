# CSSFile

The CSSFile resource lets you generate CSS files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) or [Anthropic Claude](https://www.anthropic.com/claude).

# Minimal Example

Generate a simple CSS file with basic styles.

```ts
import { CSSFile } from "alchemy/ai";

const styles = await CSSFile("main-styles", {
  path: "./public/css/main.css",
  prompt: "Generate modern CSS styles with a primary color of #0062ff and responsive layout"
});
```

# Create Component Styles

Generate CSS styles based on existing HTML components.

```ts
import { CSSFile } from "alchemy/ai";

const componentStyles = await CSSFile("component-styles", {
  path: "./src/styles/component.css", 
  prompt: await alchemy`
    Create CSS styles for this HTML component:
    ${alchemy.file("src/components/Card.html")}
    
    Include:
    - Modern and clean design
    - Hover effects and transitions
    - Light/dark theme support
    - CSS variables for colors
  `,
  temperature: 0.2
});
```