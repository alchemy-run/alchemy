# YAMLFile

The YAMLFile resource lets you generate [YAML](https://yaml.org/) files using AI models. It supports both schema-based validation and freeform YAML generation.

# Minimal Example

Generate a simple YAML configuration file:

```ts
import { YAMLFile } from "alchemy/ai";

const config = await YAMLFile("app-config", {
  path: "./config/app.yml",
  prompt: "Generate a basic web application configuration with server port, database URL, and logging level"
});
```

# Schema Validation

Use a schema to validate the generated YAML structure:

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
  },
  logging: {
    level: "'debug' | 'info' | 'warn' | 'error'"
  }
});

const config = await YAMLFile("app-config", {
  path: "./config/app.yml",
  schema: configSchema,
  prompt: "Generate a web application configuration"
});
```

# Custom System Prompt

Provide specific instructions for YAML generation:

```ts
import { YAMLFile } from "alchemy/ai";

const workflow = await YAMLFile("github-workflow", {
  path: "./.github/workflows/ci.yml",
  prompt: "Create a GitHub Actions workflow for a Node.js project with testing and deployment",
  system: "You are a DevOps expert. Create a GitHub Actions workflow following best practices.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  }
});
```