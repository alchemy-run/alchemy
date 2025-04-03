# Static YAML File

The Static YAML File resource creates a [YAML](https://yaml.org/) file with formatted content using the yaml package.

# Minimal Example

Creates a simple YAML file with basic configuration.

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config.yaml", {
  server: {
    host: "localhost",
    port: 3000
  }
});
```

# Create a Nested Configuration File

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
  },
  features: ["auth", "logging"]
});
```