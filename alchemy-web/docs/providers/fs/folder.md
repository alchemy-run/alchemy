# Folder

The Folder component allows you to create and manage directories in the filesystem with automatic parent directory creation and cleanup on deletion.

# Minimal Example

```ts
import { Folder } from "alchemy/fs";

// Create a directory using id as path
const dir = await Folder("uploads");
```

# Create the Folder

```ts
import { Folder } from "alchemy/fs";

// Create a directory with explicit path
const dir = await Folder("uploads", {
  path: "uploads"
});

// Create a nested directory structure
const logs = await Folder("var/log/app", {
  path: "var/log/app"
});
```