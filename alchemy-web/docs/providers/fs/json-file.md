# Json File

The Json File resource allows you to create and manage JSON files with formatted content in the filesystem. It is part of the Alchemy Infrastructure-as-Code (IaC) library, which is a TypeScript-native solution for managing resources. For more information on Alchemy, visit the [Alchemy GitHub repository](https://github.com/alchemy).

# Minimal Example

```ts
import { JsonFile } from "alchemy/fs";

// Create a simple JSON file
const config = await JsonFile("config.json", {
  api: {
    endpoint: "https://api.example.com",
    version: "v1"
  },
  features: ["auth", "logging"]
});
```

# Create the Json File

```ts
import { JsonFile } from "alchemy/fs";

// Create a JSON configuration file with nested objects and arrays
const settings = await JsonFile("settings.json", {
  user: {
    name: "John Doe",
    roles: ["admin", "editor"]
  },
  preferences: {
    theme: "dark",
    notifications: true
  }
});
```