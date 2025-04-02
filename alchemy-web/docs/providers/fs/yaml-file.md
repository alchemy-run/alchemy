# Yaml File

The Yaml File component allows you to create and manage YAML files with formatted content using the [YAML](https://yaml.org/) format.

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
const settings = await YamlFile("settings.yaml", {
  application: {
    name: "MyApp",
    version: "1.0.0"
  },
  logging: {
    level: "debug",
    file: "logs/app.log"
  }
});
```