# Static HTML File

The Static HTML File resource creates and manages HTML files in the filesystem. It's part of Alchemy's file system management capabilities.

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

# Create with Path and Content

```ts
import { StaticHTMLFile } from "alchemy/fs";

const page = await StaticHTMLFile("home", "public/index.html", `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Home Page</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <header>
      <h1>Welcome</h1>
    </header>
    <main>
      <p>Main content here</p>
    </main>
    <footer>
      <p>&copy; 2024</p>
    </footer>
  </body>
  </html>
`);
```