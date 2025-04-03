# Static JSON File

The Static JSON File resource creates and manages JSON files with automatic formatting using [Prettier](https://prettier.io/).

# Minimal Example

Creates a basic JSON file with formatted content.

```ts
import { StaticJsonFile } from "alchemy/fs";

const config = await StaticJsonFile("config.json", {
  name: "my-app",
  version: "1.0.0"
});
```

# Create Complex JSON File

```ts
import { StaticJsonFile } from "alchemy/fs";

const config = await StaticJsonFile("config.json", {
  api: {
    endpoint: "https://api.example.com",
    version: "v1",
    features: ["auth", "logging"]
  },
  database: {
    host: "localhost",
    port: 5432,
    credentials: {
      username: "admin",
      password: "secret"
    }
  }
});
```