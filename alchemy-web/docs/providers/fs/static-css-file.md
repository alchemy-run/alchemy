# StaticCSSFile

Creates and manages static CSS files in your project using [Alchemy's File System Resource](https://github.com/alchemyjs/alchemy).

# Minimal Example

Create a basic CSS file with styles:

```ts
import { StaticCSSFile } from "alchemy/fs";

const styles = await StaticCSSFile("styles.css", `
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 1rem;
  }
`);
```

# Create with Custom Path

Create a CSS file with a custom path:

```ts
import { StaticCSSFile } from "alchemy/fs";

const styles = await StaticCSSFile("main", 
  "src/styles/main.css",
  `.button {
    background-color: #0062ff;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
  }`
);
```