# StaticCSSFile

The StaticCSSFile resource creates static CSS files with content in your filesystem.

# Minimal Example

Creates a basic CSS file with styles.

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

# Custom Path Example

Creates a CSS file at a specific path.

```ts
import { StaticCSSFile } from "alchemy/fs";

const styles = await StaticCSSFile("main", "src/styles/main.css", `
  .button {
    background-color: #0062ff;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
  }
`);
```

# Multiple Selectors Example

Creates a CSS file with multiple style rules.

```ts
import { StaticCSSFile } from "alchemy/fs";

const styles = await StaticCSSFile("theme.css", `
  :root {
    --primary: #0062ff;
    --secondary: #6c757d;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
  }

  .button {
    background-color: var(--primary);
    color: white;
    border: none;
    padding: 0.5rem 1rem;
  }

  .button:hover {
    opacity: 0.9;
  }
`);
```