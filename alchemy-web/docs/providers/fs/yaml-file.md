# Yaml File

The Yaml File component allows you to create and manage YAML files with formatted content using the Alchemy IaC library. YAML is a human-readable data serialization standard that can be used in conjunction with all programming languages and is often used for configuration files. Learn more about YAML at [yaml.org](https://yaml.org/).

# Minimal Example

```ts
import { YamlFile } from "alchemy/fs";

// Create a simple YAML configuration file
const config = await YamlFile("config.yaml", {
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

# Create the Yaml File

```ts
import { YamlFile } from "alchemy/fs";

// Create a YAML file with nested configuration
const appConfig = await YamlFile("app-config.yaml", {
  application: {
    name: "MyApp",
    version: "1.0.0"
  },
  logging: {
    level: "info",
    format: "json"
  },
  services: {
    auth: {
      enabled: true,
      providers: ["google", "facebook"]
    }
  }
});
```