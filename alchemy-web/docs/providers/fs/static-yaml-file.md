# Static YAML File

The Static YAML File resource creates and manages YAML files with formatted content using the [YAML](https://yaml.org/) format.

## Minimal Example

Creates a basic YAML configuration file.

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("config.yaml", {
  server: {
    host: "localhost",
    port: 3000
  }
});
```

## Create a Nested YAML File

Creates a YAML file with nested configuration and custom path.

```ts
import { StaticYamlFile } from "alchemy/fs";

const config = await StaticYamlFile("database", {
  path: "config/database.yaml",
  content: {
    database: {
      url: "postgresql://localhost:5432/db",
      pool: {
        min: 1,
        max: 10
      },
      logging: true
    }
  }
});
```