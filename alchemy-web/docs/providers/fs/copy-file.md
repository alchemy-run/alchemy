# CopyFile

The CopyFile resource lets you copy files from one location to another in your filesystem.

# Minimal Example

Copy a file to a new location:

```ts
import { CopyFile } from "alchemy/fs";

const copy = await CopyFile("config-backup", {
  src: "config.json",
  dest: "backup/config.json"
});
```

# Copy Without Overwriting

Copy a file only if the destination doesn't already exist:

```ts
import { CopyFile } from "alchemy/fs";

const safeCopy = await CopyFile("safe-copy", {
  src: "data.json", 
  dest: "backup/data.json",
  overwrite: false
});
```