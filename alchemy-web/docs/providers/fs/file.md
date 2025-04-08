# File

The File resource lets you create, update, and manage files in the filesystem with automatic directory creation and cleanup.

## Minimal Example

Creates a simple text file with content.

```ts
import { File } from "alchemy/fs";

const config = await File("config.txt", {
  path: "config.txt", 
  content: "some configuration data"
});
```

## Create File in Nested Directory

Creates a file in a nested directory structure, automatically creating parent directories.

```ts
import { File } from "alchemy/fs";

const log = await File("logs/app.log", {
  path: "logs/app.log",
  content: "application log entry"
});
```

## Update File Path and Content

Updates an existing file's path and content, automatically cleaning up the old file.

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