# File

The File resource creates and manages files in the filesystem with automatic directory creation and cleanup.

## Minimal Example

Creates a simple text file:

```ts
import { File } from "alchemy/fs";

const config = await File("config.txt", {
  path: "config.txt", 
  content: "some configuration data"
});
```

## Nested Directory

Creates a file in a nested directory structure:

```ts
import { File } from "alchemy/fs";

const log = await File("logs/app.log", {
  path: "logs/app.log",
  content: "application log entry"
}); 
```

## Update Path and Content

Updates an existing file's path and content:

```ts
import { File } from "alchemy/fs";

let file = await File("config.json", {
  path: "config.json",
  content: '{ "version": "1.0.0" }'
});

// Later update path and content (old file is removed)
file = await File("config.json", {
  path: "config/config.json", 
  content: '{ "version": "1.0.1" }'
});
```