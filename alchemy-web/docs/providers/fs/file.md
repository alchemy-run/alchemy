# File

The File resource allows you to create and manage files in the filesystem with automatic directory creation and proper cleanup on deletion. For more information, visit the [Alchemy documentation](https://alchemy.example.com).

# Minimal Example

```ts
import { File } from "alchemy/fs";

// Create a simple text file
const config = await File("config.txt", {
  path: "config.txt",
  content: "some configuration data"
});
```

# Create the File

```ts
import { File } from "alchemy/fs";

// Create a file in a nested directory
const log = await File("logs/app.log", {
  path: "logs/app.log",
  content: "application log entry"
});
```