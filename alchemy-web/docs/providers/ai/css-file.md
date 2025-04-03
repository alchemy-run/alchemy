# CSS File

The CSSFile component allows you to generate and manage CSS files using AI models. It extracts CSS code from AI-generated responses and ensures the code is valid and formatted. Learn more about [CSS](https://developer.mozilla.org/en-US/docs/Web/CSS).

# Minimal Example

```ts
import { CSSFile } from "alchemy/ai";

const mainStyles = await CSSFile("main-styles", {
  path: "./public/css/main.css",
  prompt: "Generate modern CSS styles for a company website with a clean, minimalist design.",
});
```

# Create the CSS File

```ts
import { CSSFile } from "alchemy/ai";

const componentStyles = await CSSFile("component-styles", {
  path: "./src/styles/component.css",
  prompt: await alchemy`
    Create CSS styles for this HTML component:
    ${alchemy.file("src/components/Card.html")}
    The styles should be modern, include hover effects, and support both light and dark themes.
  `,
  temperature: 0.2,
});
```