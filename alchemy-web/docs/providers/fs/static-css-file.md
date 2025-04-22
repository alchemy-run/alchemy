# StaticCSSFile

The StaticCSSFile resource creates and manages static CSS files in your project using [Alchemy's File System](https://alchemy.run/docs/concepts/state.md) capabilities.

# Minimal Example

Creates a CSS file with basic styles.

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

# Custom Path

Creates a CSS file at a specific path.

```ts
import { StaticCSSFile } from "alchemy/fs";

const styles = await StaticCSSFile("main", "src/styles/main.css", `
  body {
    font-family: sans-serif;
    line-height: 1.5;
  }
  
  .button {
    background: #0062ff;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
  }
`);
```