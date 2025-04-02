# Json File

The Json File resource allows you to create and manage JSON files with formatted content in the filesystem. This resource is part of the Alchemy Infrastructure-as-Code (IaC) library, which is designed to be lightweight and TypeScript-native.

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

// Create a JSON configuration file with nested objects
const settings = await JsonFile("settings.json", {
  database: {
    host: "localhost",
    port: 5432,
    user: "admin"
  },
  services: {
    authService: {
      url: "https://auth.example.com",
      timeout: 5000
    }
  }
});
```