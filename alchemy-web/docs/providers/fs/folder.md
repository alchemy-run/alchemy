# Folder

The Folder resource creates and manages directories in the filesystem with automatic parent directory creation and cleanup on deletion.

# Minimal Example

Creates a basic directory using the ID as the path.

```ts
import { Folder } from "alchemy/fs";

const dir = await Folder("uploads");
```

# Create a Nested Directory

Creates a directory with an explicit path and recursive parent directory creation.

```ts
import { Folder } from "alchemy/fs";

const logs = await Folder("logs", {
  path: "var/log/app",
  recursive: true 
});
```

# Create a Temporary Directory

Creates a directory that will be cleaned up during deletion, even if it contains files.

```ts
import { Folder } from "alchemy/fs";

const temp = await Folder("temp", {
  path: "tmp/cache",
  clean: true,
  delete: true
});
```