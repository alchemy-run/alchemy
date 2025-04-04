# Static YAML File

Creates and manages [YAML](https://yaml.org/) files with automatic formatting using the yaml package.

# Minimal Example

Creates a simple YAML configuration file.

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config.yaml", {
  server: {
    host: "localhost",
    port: 3000
  }
});
```

# Create a Nested Configuration

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config.yaml", {
  server: {
    host: "localhost", 
    port: 3000
  },
  database: {
    url: "postgresql://localhost:5432/db",
    pool: {
      min: 1,
      max: 10
    }
  }
});
```

# Create with Custom Path

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config", 
  "config/production.yaml",
  {
    environment: "production",
    features: {
      auth: true,
      logging: true
    }
  }
);
```