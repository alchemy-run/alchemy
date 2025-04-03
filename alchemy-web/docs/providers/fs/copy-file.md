# Copy File

The Copy File resource allows you to copy files from a source location to a destination location within the filesystem. It provides options to overwrite existing files at the destination. This resource is part of the Alchemy IaC library, which is designed for managing infrastructure as code in a TypeScript-native environment. For more information, visit the [Alchemy website](https://alchemy.com).

# Minimal Example

```ts
import { CopyFile } from "alchemy/fs";

// Copy a file from 'source.txt' to 'destination.txt'
const copiedFile = await CopyFile("example-copy", {
  src: "source.txt",
  dest: "destination.txt"
});
```

# Create the Copy File

```ts
import { CopyFile } from "alchemy/fs";

// Copy a file with overwrite option set to false
const safeCopy = await CopyFile("safe-copy", {
  src: "data.json",
  dest: "backup/data.json",
  overwrite: false
});
```