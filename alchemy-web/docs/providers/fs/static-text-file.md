# Static Text File

The Static Text File resource creates and manages plain text files in the filesystem using [Node.js File System](https://nodejs.org/api/fs.html).

# Minimal Example

Creates a basic text file with content.

```ts
import { StaticTextFile } from "alchemy/fs";

const readme = await StaticTextFile("README.md", "# Project Name\n\nProject description goes here.");
```

# Create with Custom Path

Creates a text file at a specific path location.

```ts
import { StaticTextFile } from "alchemy/fs";

const doc = await StaticTextFile("docs/guide.md", 
  "docs/getting-started.md",
  "# Getting Started\n\nFollow these steps to get started..."
);
```