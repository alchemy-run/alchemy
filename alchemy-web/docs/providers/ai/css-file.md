# CSS File

The CSS File resource lets you generate CSS files using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) or [Anthropic Claude](https://www.anthropic.com/claude).

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

Generate CSS styles for a specific component with hover effects and animations.

```ts
import { CSSFile } from "alchemy/ai";

const cardStyles = await CSSFile("card-styles", {
  path: "./src/styles/card.css", 
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

# Generate Animation Library

Create a reusable CSS animation library with custom system prompt.

```ts
import { CSSFile } from "alchemy/ai";

const animations = await CSSFile("animations", {
  path: "./src/styles/animations.css",
  prompt: "Create CSS animations for fade, slide, bounce, and scale effects",
  system: "You are an expert CSS animator. Create animations using modern techniques and include vendor prefixes.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```