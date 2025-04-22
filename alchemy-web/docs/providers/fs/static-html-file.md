# StaticHTMLFile

The StaticHTMLFile resource creates static HTML files in your filesystem using [Alchemy's File System](https://alchemy.run/docs/concepts/fs) capabilities.

# Minimal Example

Creates a basic HTML file with the specified content.

```ts
import { StaticHTMLFile } from "alchemy/fs";

const page = await StaticHTMLFile("index.html", `
  <!DOCTYPE html>
  <html>
    <head>
      <title>My Page</title>
    </head>
    <body>
      <h1>Hello World</h1>
    </body>
  </html>
`);
```

# Custom Path

Creates an HTML file at a specific path location.

```ts
import { StaticHTMLFile } from "alchemy/fs";

const page = await StaticHTMLFile("home", 
  "pages/home.html",
  `<!DOCTYPE html>
  <html>
    <head>
      <title>Home</title>
    </head>
    <body>
      <h1>Welcome Home</h1>
    </body>
  </html>`
);
```

# Full Page Example

Creates a complete HTML page with metadata, styles and content.

```ts
import { StaticHTMLFile } from "alchemy/fs";

const page = await StaticHTMLFile("index.html", `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Website</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <header>
      <h1>Welcome to My Website</h1>
    </header>
    <main>
      <p>This is the main content of the page.</p>
    </main>
    <footer>
      <p>&copy; 2024 My Company</p>
    </footer>
  </body>
  </html>
`);
```