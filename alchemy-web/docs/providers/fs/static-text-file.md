# StaticTextFile

The StaticTextFile resource creates plain text files in your filesystem using [Node.js File System](https://nodejs.org/api/fs.html).

# Minimal Example

Creates a simple text file with content.

```ts
import { StaticTextFile } from "alchemy/fs";

const readme = await StaticTextFile("README.md", 
  "# Project Name\n\nProject description goes here."
);
```

# Custom Path

Creates a text file at a specific path.

```ts
import { StaticTextFile } from "alchemy/fs";

const log = await StaticTextFile("app.log", 
  "logs/app.log",
  "Application started successfully"
);
```

# Nested Directories

Creates a text file in nested directories (directories are created automatically).

```ts
import { StaticTextFile } from "alchemy/fs";

const config = await StaticTextFile("config", 
  "config/settings/app.conf",
  "debug=true\nport=3000"
);
```