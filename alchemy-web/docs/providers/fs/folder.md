# Folder

The Folder resource creates and manages directories in the filesystem with automatic parent directory creation and cleanup on deletion.

## Minimal Example

Create a simple directory:

```ts
import { Folder } from "alchemy/fs";

const uploads = await Folder("uploads");
```

## Create Nested Directory

Create a nested directory structure with recursive creation:

```ts
import { Folder } from "alchemy/fs";

const logs = await Folder("logs", {
  path: "var/log/app",
  recursive: true 
});
```

## Preserve Directory on Delete

Keep the directory when deleting the resource:

```ts
import { Folder } from "alchemy/fs";

const temp = await Folder("temp", {
  path: "tmp",
  delete: false
});
```

## Clean Directory on Delete

Remove all contents when deleting the directory:

```ts
import { Folder } from "alchemy/fs";

const cache = await Folder("cache", {
  path: "cache",
  clean: true
});
```