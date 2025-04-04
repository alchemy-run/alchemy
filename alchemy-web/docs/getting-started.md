# Getting Started with Alchemy

Alchemy is a TypeScript-native Infrastructure-as-Code (IaC) library that lets you model infrastructure resources using simple async functions.

## Installation

```bash
bun add alchemy
```

## Creating Your First Resource

Create a new file called `alchemy.run.ts`:

```ts
import { alchemy } from "alchemy";
import { File } from "alchemy/fs";

// Initialize alchemy
await using app = alchemy("my-app");

// Create a file resource
await File("hello.txt", {
  path: "./hello.txt",
  content: "Hello World!"
});
```

Run the script to create the file:

```bash
bun ./alchemy.run.ts
```

This will:
1. Create a new file at `./hello.txt` with the content "Hello World!"
2. Create a state file at `.alchemy/my-app/dev/hello.txt.json`

## Understanding State Files

The `.alchemy` directory contains state files that track the resources you create:

```
.alchemy/
  my-app/           # Application scope
    dev/            # Stage scope (default)
      hello.txt.json  # Resource state
```

The state file contains information about the resource:

```json
{
  "provider": "fs::File",
  "data": {},
  "deps": [],
  "status": "updated",
  "output": {
    "path": "./hello.txt",
    "content": "Hello World!"
  },
  "props": {
    "path": "./hello.txt", 
    "content": "Hello World!"
  }
}
```

## Removing Resources

To remove the file resource, delete it from your script and run again:

```ts
import { alchemy } from "alchemy";
// Remove the File import and resource creation

await using app = alchemy("my-app");
// File resource removed
```

Run the script:

```bash
bun ./alchemy.run.ts
```

This will:
1. Delete the `hello.txt` file
2. Remove the state file from `.alchemy/my-app/dev/hello.txt.json`

## Next Steps

- Check out the [examples](./examples/) for more complex use cases
- See the [Cloudflare Deployment Guide](./docs/cloudflare.md) to deploy workers
- Read the [README](./README.md) for a complete overview of Alchemy