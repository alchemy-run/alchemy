# Static HTML File

The Static HTML File resource lets you create and manage static HTML files in your project's filesystem.

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

# Create with Custom Path

Creates an HTML file at a specific path location.

```ts
import { StaticHTMLFile } from "alchemy/fs";

const page = await StaticHTMLFile("home", 
  "pages/home.html",
  `<!DOCTYPE html>
  <html>
    <head>
      <title>Home</title>
      <link rel="stylesheet" href="styles.css">
    </head>
    <body>
      <h1>Welcome Home</h1>
    </body>
  </html>`
);
```