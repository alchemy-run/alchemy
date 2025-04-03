# Static Yaml File

The Static Yaml File resource allows you to create YAML files with formatted content using [YAML](https://yaml.org/).

# Minimal Example

```ts
import { StaticYamlFile } from "alchemy/fs";

// Create a simple YAML configuration file
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

# Create the Static Yaml File

```ts
import { StaticYamlFile } from "alchemy/fs";

// Create a YAML file with nested configuration
const advancedConfig = await StaticYamlFile("advanced-config.yaml", {
  application: {
    name: "MyApp",
    version: "1.0.0"
  },
  logging: {
    level: "debug",
    format: "json"
  },
  features: {
    authentication: true,
    caching: {
      enabled: true,
      strategy: "LRU"
    }
  }
});
```