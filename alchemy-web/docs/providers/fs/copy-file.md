# Copy File

The Copy File resource lets you copy files from one location to another in the filesystem with automatic directory creation and cleanup.

# Minimal Example

Creates a copy of a file at a new location.

```ts
import { CopyFile } from "alchemy/fs";

const copiedFile = await CopyFile("config-copy", {
  src: "config.json", 
  dest: "backup/config.json"
});
```

# Create the Copy File

```ts
import { CopyFile } from "alchemy/fs";

const safeCopy = await CopyFile("safe-copy", {
  src: "data.json",
  dest: "backup/data.json",
  overwrite: false // Don't overwrite if destination exists
});
```