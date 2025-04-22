# StaticJsonFile

The StaticJsonFile resource creates formatted JSON files using [Prettier](https://prettier.io/) for consistent formatting.

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

Creates a JSON file at a specific path.

```ts
import { StaticJsonFile } from "alchemy/fs";

const config = await StaticJsonFile("config", {
  path: "src/config/app.json", 
  content: {
    api: {
      endpoint: "https://api.example.com",
      version: "v1"
    },
    features: ["auth", "logging"]
  }
});
```

# Complex Configuration

Creates a JSON file with nested configuration.

```ts
import { StaticJsonFile } from "alchemy/fs";

const settings = await StaticJsonFile("settings.json", {
  server: {
    host: "localhost",
    port: 3000,
    middleware: ["cors", "compression"]
  },
  database: {
    url: "postgresql://localhost:5432/db",
    pool: {
      min: 1,
      max: 10
    }
  },
  logging: {
    level: "info",
    transports: ["console", "file"]
  }
});
```