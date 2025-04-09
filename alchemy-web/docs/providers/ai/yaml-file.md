# YAMLFile

The YAMLFile resource lets you generate YAML files using AI models. It supports both schema-validated and freeform YAML generation.

# Minimal Example

Generate a simple YAML configuration file:

```ts
import { YAMLFile } from "alchemy/ai";

const config = await YAMLFile("app-config", {
  path: "./config.yml",
  prompt: "Generate a basic application config with server port, database URL, and logging level"
});
```

# Schema Validation

Use a schema to ensure the generated YAML matches your type requirements:

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
  path: "./config.yml",
  schema: configSchema,
  prompt: "Generate a server configuration with database settings"
});
```

# Context-Aware Generation

Use alchemy template literals to include file context in the prompt:

```ts
import { YAMLFile } from "alchemy/ai";

const k8sConfig = await YAMLFile("k8s-config", {
  path: "./k8s/deployment.yml",
  prompt: await alchemy`
    Generate a Kubernetes deployment config based on:
    ${alchemy.file("src/app.ts")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```