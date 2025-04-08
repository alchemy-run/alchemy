# StaticTextFile

The StaticTextFile resource creates and manages plain text files in the filesystem. It is part of the [Alchemy File System](https://github.com/alchemyjs/alchemy) service.

# Minimal Example

Create a simple text file with content:

```ts
import { StaticTextFile } from "alchemy/fs";

const readme = await StaticTextFile("README.md", 
  "# Project Name\n\nProject description goes here."
);
```

# Create with Custom Path

Create a text file with an explicit path different from the ID:

```ts
import { StaticTextFile } from "alchemy/fs";

const changelog = await StaticTextFile("changelog", 
  "docs/CHANGELOG.md",
  "# Changelog\n\n## v1.0.0\n- Initial release"
);
```