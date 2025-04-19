# Folder

The Folder resource creates and manages directories in the filesystem with automatic parent directory creation and cleanup on deletion.

## Minimal Example

Creates a directory using the ID as the path:

```ts
import { Folder } from "alchemy/fs";

const dir = await Folder("uploads");
```

## Custom Path

Specify an explicit path for the directory:

```ts
import { Folder } from "alchemy/fs";

const logs = await Folder("logs", {
  path: "var/log/app"
});
```

## Recursive Creation

Create nested directory structures automatically:

```ts
import { Folder } from "alchemy/fs";

const nested = await Folder("nested", {
  path: "path/to/nested/dir",
  recursive: true // default is true
});
```

## Cleanup Options

Control how folders are cleaned up during deletion:

```ts
import { Folder } from "alchemy/fs";

const temp = await Folder("temp", {
  path: "temp",
  delete: true,    // Whether to delete on destroy (default true)
  clean: true      // Remove contents during deletion (default false)
});
```