# File

The File resource in Alchemy allows you to create and manage files in the filesystem with automatic directory creation and proper cleanup on deletion. This resource is part of the Alchemy Infrastructure-as-Code (IaC) library, which is a TypeScript-native solution for managing resources. For more information, visit the [Alchemy GitHub repository](https://github.com/alchemy).

# Minimal Example

```ts twoslash
import { File } from "alchemy/fs";

// Create a simple text file
const config = await File("config.txt", {
  path: "config.txt",
  content: "some configuration data"
});
```

# Create the File

```ts twoslash
import { File } from "alchemy/fs";

// Create a file in a nested directory
const log = await File("logs/app.log", {
  path: "logs/app.log",
  content: "application log entry"
});
```