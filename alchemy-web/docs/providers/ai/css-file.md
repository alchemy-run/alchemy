# CSSFile

The CSSFile resource lets you generate CSS files using AI models. It extracts CSS code from between ```css fences, validates the response, and creates a file at the specified path.

# Minimal Example

Generate a simple CSS file with basic styles.

```ts
import { CSSFile } from "alchemy/ai";

const styles = await CSSFile("main-styles", {
  path: "./public/css/main.css",
  prompt: "Generate modern CSS styles with a primary color of #0062ff and responsive layout"
});
```

# Generate Styles Based on HTML

Generate CSS styles by referencing existing HTML components.

```ts
import { CSSFile } from "alchemy/ai";

const componentStyles = await CSSFile("component-styles", {
  path: "./src/styles/component.css", 
  prompt: await alchemy`
    Create CSS styles for this HTML component:
    ${alchemy.file("src/components/Card.html")}
    
    Include hover effects and dark/light theme support
  `,
  temperature: 0.2
});
```

# Custom System Prompt

Use a custom system prompt to guide the AI's output format.

```ts
import { CSSFile } from "alchemy/ai";

const animations = await CSSFile("animations", {
  path: "./src/styles/animations.css",
  prompt: "Create reusable CSS animations for fade, slide, and bounce effects",
  system: "You are an expert CSS animator. Create a single CSS file inside ```css fences with no additional text. Use modern CSS animation techniques and include vendor prefixes.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```