# Static Text File

The Static Text File resource creates and manages plain text files in the filesystem using [Node.js fs module](https://nodejs.org/api/fs.html).

# Minimal Example

Creates a basic text file with content.

```ts
import { StaticTextFile } from "alchemy/fs";

const readme = await StaticTextFile("README.md", 
  "# Project Name\n\nProject description goes here."
);
```

# Create with Custom Path

Creates a text file at a specific path location.

```ts
import { StaticTextFile } from "alchemy/fs";

const changelog = await StaticTextFile("changelog", {
  path: "docs/CHANGELOG.md",
  content: "# Changelog\n\n## v1.0.0\n- Initial release"
});
```