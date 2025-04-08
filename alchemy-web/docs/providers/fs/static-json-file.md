# StaticJsonFile

The StaticJsonFile resource creates formatted JSON files using [Prettier](https://prettier.io/) for consistent formatting.

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

# Create Nested JSON

Creates a JSON file with nested configuration data.

```ts
import { StaticJsonFile } from "alchemy/fs";

const dbConfig = await StaticJsonFile("database.json", {
  connection: {
    host: "localhost",
    port: 5432,
    credentials: {
      username: "admin",
      password: "secret"
    }
  },
  pool: {
    min: 1,
    max: 10,
    idleTimeout: 60000
  }
});
```