# CopyFile

The CopyFile resource copies files from one location to another in the filesystem. It provides options for overwriting existing files and handles cleanup during deletion.

## Minimal Example

Copy a file to a new location:

```ts
import { CopyFile } from "alchemy/fs";

const copiedFile = await CopyFile("config-backup", {
  src: "config.json",
  dest: "backup/config.json"
});
```

## Copy Without Overwriting

Prevent overwriting existing destination files:

```ts
import { CopyFile } from "alchemy/fs";

const safeCopy = await CopyFile("safe-copy", {
  src: "data.json", 
  dest: "backup/data.json",
  overwrite: false
});
```

## Copy with Cleanup

The destination file will be automatically deleted when the resource is destroyed:

```ts
import { CopyFile, destroy } from "alchemy/fs";

const tempCopy = await CopyFile("temp-copy", {
  src: "data.json",
  dest: "temp/data.json"
});

// Later, clean up the copied file
await destroy(scope);
```