# Static JSON File

Creates and manages JSON files with automatic formatting using [Prettier](https://prettier.io/). The content is automatically formatted with proper indentation and spacing.

# Minimal Example

Creates a simple JSON configuration file.

```ts
import { StaticJsonFile } from "alchemy/fs";

const config = await StaticJsonFile("config.json", {
  api: {
    endpoint: "https://api.example.com",
    version: "v1"
  }
});
```

# Create with Custom Path

Creates a JSON file at a specific path location.

```ts
import { StaticJsonFile } from "alchemy/fs";

const settings = await StaticJsonFile("settings", {
  path: "config/settings.json",
  content: {
    theme: "dark",
    notifications: true,
    language: "en"
  }
});
```

# Complex Configuration Example

Creates a JSON file with nested configuration data.

```ts
import { StaticJsonFile } from "alchemy/fs";

const appConfig = await StaticJsonFile("app-config.json", {
  server: {
    host: "localhost",
    port: 3000,
    cors: {
      origins: ["https://example.com"],
      methods: ["GET", "POST"]
    }
  },
  database: {
    url: "postgresql://localhost:5432/db",
    pool: {
      min: 1,
      max: 10
    }
  },
  features: ["auth", "logging", "metrics"]
});
```