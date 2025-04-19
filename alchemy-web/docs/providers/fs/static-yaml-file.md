# StaticYamlFile

The StaticYamlFile resource creates YAML files with formatted content using the [yaml](https://www.npmjs.com/package/yaml) package.

# Minimal Example

Creates a simple YAML file with basic configuration:

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config.yaml", {
  server: {
    host: "localhost",
    port: 3000
  }
});
```

# Nested Configuration

Creates a YAML file with nested configuration structure:

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

# Custom Path

Creates a YAML file at a specific path:

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config", "config/app.yaml", {
  name: "my-app",
  version: "1.0.0",
  environment: "production"
});
```