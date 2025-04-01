# Yaml File

The Yaml File resource allows you to create and manage YAML files in the filesystem with formatted content. This is useful for configuration files and other structured data formats. Learn more about YAML at [yaml.org](https://yaml.org/).

# Minimal Example

```ts twoslash
import { YamlFile } from "alchemy/fs";

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
//  ^?
```

# Create the Yaml File

```ts twoslash
import { YamlFile } from "alchemy/fs";

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
//  ^?
```

In these examples, a YAML configuration file is created with server and database settings, demonstrating how to structure and format YAML content using the `YamlFile` resource.