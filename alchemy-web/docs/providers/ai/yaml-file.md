# YAMLFile

The YAMLFile resource lets you generate [YAML](https://yaml.org/) files using AI models. It supports both schema-based validation and freeform YAML generation.

# Minimal Example

Generate a simple YAML configuration file:

```ts
import { YAMLFile } from "alchemy/ai";

const config = await YAMLFile("app-config", {
  path: "./config/app.yml",
  prompt: "Generate a basic YAML config with server port, host and database connection settings"
});
```

# Generate YAML with Schema Validation 

Use an ArkType schema to validate and structure the generated YAML:

```ts
import { YAMLFile } from "alchemy/ai";
import { type } from "arktype";

const configSchema = type({
  server: {
    port: "number",
    host: "string"
  },
  database: {
    url: "string",
    maxConnections: "number"
  }
});

const config = await YAMLFile("app-config", {
  path: "./config/app.yml",
  schema: configSchema,
  prompt: "Generate a server configuration with database settings",
  temperature: 0.2
});
```