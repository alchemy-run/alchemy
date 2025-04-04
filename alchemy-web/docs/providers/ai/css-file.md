# CSS File

The CSS File resource lets you generate CSS code using AI models like [OpenAI GPT-4](https://platform.openai.com/docs/models/gpt-4) and [Anthropic Claude](https://www.anthropic.com/claude).

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
  path: "./styles/card.css", 
  prompt: await alchemy`
    Create CSS styles for this HTML component:
    ${alchemy.file("src/components/Card.html")}
    
    Include:
    - Modern and clean design
    - Hover effects and transitions
    - Support for light/dark themes
    - CSS variables for colors
  `,
  temperature: 0.2
});
```

# Generate CSS Animations

Create reusable CSS animations with custom configuration.

```ts
import { CSSFile } from "alchemy/ai";

const animations = await CSSFile("animations", {
  path: "./styles/animations.css",
  prompt: "Create CSS animations for fade, slide, bounce and scale effects",
  system: "You are an expert CSS animator. Create animations using modern techniques and include vendor prefixes.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```