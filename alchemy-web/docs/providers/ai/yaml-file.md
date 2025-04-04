# YAML File

The YAML File resource lets you generate [YAML](https://yaml.org/) files using AI models. It supports both schema-based validation and freeform YAML generation.

# Minimal Example

Generate a simple YAML configuration file.

```ts
import { YAMLFile } from "alchemy/ai";

const config = await YAMLFile("app-config", {
  path: "./config.yml",
  prompt: "Generate a basic application configuration with server settings and database connection details"
});
```

# Create a YAML File with Schema Validation

```ts
import { YAMLFile } from "alchemy/ai";
import { type } from "arktype";

const configSchema = type({
  server: {
    port: "number",
    host: "string",
    timeout: "number"
  },
  database: {
    url: "string",
    maxConnections: "number"
  }
});

const config = await YAMLFile("app-config", {
  path: "./config.yml",
  schema: configSchema,
  prompt: "Generate a configuration with server and database settings",
  temperature: 0.2
});
```

# Generate a Kubernetes Configuration

```ts
import { YAMLFile } from "alchemy/ai";

const deployment = await YAMLFile("k8s-deployment", {
  path: "./kubernetes/deployment.yaml",
  prompt: await alchemy`
    Create a Kubernetes deployment for a web application that:
    - Uses nginx:latest image
    - Has 3 replicas
    - Exposes port 80
    - Includes resource limits
    - Sets up health checks
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```