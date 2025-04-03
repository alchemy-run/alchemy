# YAML File

The YAML File resource lets you generate [YAML](https://yaml.org/) files using AI models. It supports schema validation and can extract YAML from code blocks.

# Minimal Example

Creates a simple YAML configuration file.

```ts
import { YAMLFile } from "alchemy/ai";

const config = await YAMLFile("config", {
  path: "./config.yml",
  prompt: "Generate a basic nginx configuration with server blocks for port 80"
});
```

# Create a YAML File with Schema Validation

```ts
import { YAMLFile } from "alchemy/ai";
import { type } from "arktype";

const schema = type({
  service: "string",
  provider: "string",
  functions: [{
    name: "string",
    handler: "string",
    events: [{
      http: {
        path: "string",
        method: "string"
      }
    }]
  }]
});

const serverless = await YAMLFile("serverless", {
  path: "serverless.yml",
  schema,
  prompt: "Generate a serverless.yml for a basic API with GET and POST endpoints",
  temperature: 0.2
});
```