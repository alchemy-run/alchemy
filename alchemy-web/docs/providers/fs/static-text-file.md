# Static Text File

The Static Text File resource lets you create and manage plain text files in your filesystem.

# Minimal Example

Creates a simple text file with content.

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

const changelog = await StaticTextFile("changelog", 
  "docs/CHANGELOG.md",
  "# Changelog\n\n## v1.0.0\n- Initial release"
);
```