# StaticHTMLFile

The StaticHTMLFile resource creates static HTML files in your project's filesystem. It extends the base [File](./file.md) resource type.

# Minimal Example

Create a basic HTML file with content:

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

Create an HTML file at a specific path:

```ts
import { StaticHTMLFile } from "alchemy/fs";

const page = await StaticHTMLFile("home", 
  "pages/index.html",
  `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <title>Home</title>
      <link rel="stylesheet" href="styles.css">
    </head>
    <body>
      <main>
        <h1>Welcome</h1>
        <p>This is the home page.</p>
      </main>
    </body>
  </html>`
);
```