# Static Json File

The Static Json File resource allows you to create a JSON file with formatted content using [Alchemy](https://alchemy.com). This resource is useful for generating configuration files or storing structured data in a JSON format.

# Minimal Example

```ts
import { StaticJsonFile } from "alchemy/fs";

// Create a simple JSON file
const config = await StaticJsonFile("config.json", {
  api: {
    endpoint: "https://api.example.com",
    version: "v1"
  },
  features: ["auth", "logging"]
});
```

# Create the Static Json File

```ts
import { StaticJsonFile } from "alchemy/fs";

// Create a JSON configuration file with nested objects and arrays
const settings = await StaticJsonFile("settings.json", {
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