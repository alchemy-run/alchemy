# Json File

The Json File resource allows you to create and manage JSON files with formatted content in the filesystem.

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
    email: "john.doe@example.com"
  },
  preferences: {
    theme: "dark",
    notifications: true
  },
  roles: ["admin", "editor"]
});
```