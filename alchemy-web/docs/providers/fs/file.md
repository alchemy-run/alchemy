# File

The File resource creates and manages files in the filesystem with automatic directory creation and cleanup.

## Minimal Example

Creates a simple text file:

```ts
import { File } from "alchemy/fs";

const config = await File("config.txt", {
  path: "config.txt", 
  content: "some configuration data"
});
```

## Create File in Nested Directory

Automatically creates parent directories as needed:

```ts
const log = await File("logs/app.log", {
  path: "logs/app.log",
  content: "application log entry"
});
```

## Update File Path and Content

Updates file content and moves it to a new location:

```ts
let file = await File("config.json", {
  path: "config.json",
  content: '{ "version": "1.0.0" }'
});

// Later, update path and content (old file will be removed)
file = await File("config.json", {
  path: "config/config.json", 
  content: '{ "version": "1.0.1" }'
});
```

## Specialized File Types

The fs service provides specialized file types for common formats:

```ts
import { StaticJsonFile, StaticTypeScriptFile, StaticYamlFile } from "alchemy/fs";

// Create formatted JSON file
const config = await StaticJsonFile("config.json", {
  api: {
    endpoint: "https://api.example.com",
    version: "v1"
  }
});

// Create formatted TypeScript file
const component = await StaticTypeScriptFile("Component.ts", `
  interface Props {
    name: string;
  }
  export function Component({ name }: Props) {
    return <div>Hello {name}</div>;
  }
`);

// Create YAML file
const deployment = await StaticYamlFile("deploy.yaml", {
  service: {
    name: "api",
    replicas: 3
  }
});
```