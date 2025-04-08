# Getting Started with Alchemy

Alchemy is a TypeScript-native Infrastructure-as-Code library that lets you model cloud resources as simple async functions.

## Installation 

```bash
bun add alchemy
```

Note that there's nothing special about `alchemy.run.ts` - it's just a regular TypeScript script that can run anywhere.

## Your First Alchemy Application

Here's a minimal example that creates a file resource:

```ts
import alchemy from "alchemy";
import { File } from "alchemy/fs";

await using app = alchemy("my-app", {
  stage: "dev"
});

await File("hello.txt", {
  path: "./hello.txt",
  content: "Hello World!"
});
```

## Creating Your First Resource

Let's create a simple File resource:

```ts
const file = await File("config.json", {
  path: "./config.json",
  content: JSON.stringify({
    name: "my-app",
    version: "1.0.0"
  }, null, 2)
});
```

## Running the Application

Run the application with:

```bash
bun ./alchemy.run.ts
```

This will create the file at `./config.json` with the specified content.

## Understanding State

Alchemy tracks resource state in the `.alchemy/` folder:

```
.alchemy/
  my-app/
    dev/
      config.json.state
```

The state file contains information about the resource like:
- Current properties
- Output values 
- Status (created/updated/deleted)

## Resource Lifecycle

Let's see what happens when we remove the resource:

```ts
// Delete alchemy.run.ts or remove the File resource

// Run again to trigger deletion
bun ./alchemy.run.ts
```

The file will be deleted along with its state file since it's no longer referenced in the code.

## Next Steps

1. Jump to [examples](https://github.com/sam-goodwin/alchemy/tree/main/examples)
   1. [Deploying a Cloudflare Worker and Static Site](/docs/tutorials/deploy-cloudflare-worker-and-static-site)
2. [Bundling and Deploying an AWS Lambda Function](/docs/tutorials/deploy-aws-lambda-function) 
3. [Create a Custom Resource with AI](/docs/tutorials/writing-custom-resource)

See [README.md](./README.md) for an overview of Alchemy concepts.