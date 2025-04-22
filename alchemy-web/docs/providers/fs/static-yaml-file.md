# StaticYamlFile

The StaticYamlFile resource creates YAML files with formatted content using the [yaml](https://www.npmjs.com/package/yaml) package.

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

# Custom Path

Creates a YAML file at a specific path.

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config", "config/app.yaml", {
  database: {
    url: "postgresql://localhost:5432/db",
    pool: {
      min: 1,
      max: 10
    }
  }
});
```