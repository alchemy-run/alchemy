# Static CSS File

The Static CSS File resource lets you create and manage [CSS (Cascading Style Sheets)](https://developer.mozilla.org/en-US/docs/Web/CSS) files in your project.

# Minimal Example

Creates a basic CSS file with styles.

```ts
import { StaticCSSFile } from "alchemy/fs";

const styles = await StaticCSSFile("styles.css", `
  .container {
    max-width: 1200px;
    margin: 0 auto;
  }
`);
```

# Create with Custom Path

```ts
import { StaticCSSFile } from "alchemy/fs";

const styles = await StaticCSSFile("main", 
  "src/styles/main.css",
  `.button {
    background: #0062ff;
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 4px;
  }`
);
```