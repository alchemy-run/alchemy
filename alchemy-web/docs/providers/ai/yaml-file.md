# YAML File

The YAML File resource lets you generate [YAML](https://yaml.org/) files using AI models. It supports both schema-based validation and freeform YAML generation.

# Minimal Example

Generate a simple YAML configuration file.

```ts
import { YAMLFile } from "alchemy/ai";

const config = await YAMLFile("app-config", {
  path: "./config.yml",
  prompt: "Generate a basic app configuration with server settings and database connection"
});
```

# Generate YAML with Schema Validation

Use a schema to ensure the generated YAML matches your requirements.

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
  prompt: "Generate a configuration with server port 3000 and PostgreSQL database"
});
```

# Generate Kubernetes Configuration

Create Kubernetes resource definitions with proper YAML formatting.

```ts
import { YAMLFile } from "alchemy/ai";

const deployment = await YAMLFile("k8s-deployment", {
  path: "./deployment.yml",
  prompt: "Generate a Kubernetes deployment for a web app with 3 replicas using nginx:latest",
  system: "You are a Kubernetes expert. Create valid Kubernetes YAML manifests."
});
```