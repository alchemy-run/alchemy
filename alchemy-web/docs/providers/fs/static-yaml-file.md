# StaticYamlFile

Creates a YAML file with formatted content using the [yaml](https://www.npmjs.com/package/yaml) package.

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

# Create Nested Configuration

Creates a YAML file with nested configuration options.

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
  logging: {
    level: "info",
    format: "json"
  }
});
```