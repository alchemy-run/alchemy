# Folder

The Folder resource creates and manages directories in the filesystem with automatic parent directory creation and cleanup on deletion.

# Minimal Example

Creates a basic directory using the ID as the path.

```ts
import { Folder } from "alchemy/fs";

const dir = await Folder("uploads");
```

# Create a Nested Directory

Creates a directory with an explicit path and nested structure.

```ts
import { Folder } from "alchemy/fs";

const logs = await Folder("logs", {
  path: "var/log/app",
  recursive: true
});
```

# Create a Persistent Directory 

Creates a directory that won't be deleted during cleanup.

```ts
import { Folder } from "alchemy/fs";

const data = await Folder("data", {
  path: "data",
  delete: false
});
```

# Create a Clean Directory

Creates a directory that will be cleaned (emptied) during deletion.

```ts
import { Folder } from "alchemy/fs";

const temp = await Folder("temp", {
  path: "temp",
  clean: true
});
```