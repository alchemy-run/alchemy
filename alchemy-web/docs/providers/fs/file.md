# File

The File resource lets you create and manage files in the filesystem with automatic directory creation and cleanup.

# Minimal Example

Creates a simple text file with content.

```ts
import { File } from "alchemy/fs";

const file = await File("config.txt", {
  path: "config.txt", 
  content: "some configuration data"
});
```

# Create Files

```ts
import { File } from "alchemy/fs";

// Create file in nested directory
const log = await File("logs/app.log", {
  path: "logs/app.log",
  content: "application log entry"
});

// Create file using id as path
const readme = await File("README.md", {
  content: "# Project Documentation"
});
```

# Static File Types

```ts
import { StaticJsonFile, StaticYamlFile, StaticTypeScriptFile } from "alchemy/fs";

// Create formatted JSON file
const config = await StaticJsonFile("config.json", {
  api: {
    endpoint: "https://api.example.com",
    version: "v1"
  }
});

// Create YAML file
const deployment = await StaticYamlFile("deploy.yaml", {
  service: "web",
  replicas: 3
});

// Create TypeScript file
const component = await StaticTypeScriptFile("Component.ts", `
  interface Props {
    name: string;
  }
  export function Component({name}: Props) {
    return <div>{name}</div>;
  }
`);
```

# Copy Files

```ts
import { CopyFile } from "alchemy/fs";

// Copy file with overwrite
const backup = await CopyFile("backup", {
  src: "config.json",
  dest: "backup/config.json",
  overwrite: true
});

// Copy without overwriting existing
const safe = await CopyFile("safe", {
  src: "data.txt", 
  dest: "archive/data.txt",
  overwrite: false
});
```