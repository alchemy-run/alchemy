# StaticJsonFile

The StaticJsonFile resource creates formatted JSON files with automatic directory creation and cleanup. It uses Prettier for consistent JSON formatting.

# Minimal Example

Creates a simple JSON configuration file.

```ts
import { StaticJsonFile } from "alchemy/fs";

const config = await StaticJsonFile("config.json", {
  name: "my-app",
  version: "1.0.0"
});
```

# Custom Path

Creates a JSON file at a specific path, creating parent directories as needed.

```ts
import { StaticJsonFile } from "alchemy/fs";

const config = await StaticJsonFile("config", {
  path: "config/settings.json", 
  content: {
    api: {
      endpoint: "https://api.example.com",
      version: "v1"
    },
    features: ["auth", "logging"]
  }
});
```