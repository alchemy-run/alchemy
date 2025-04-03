# YAML File

The YAML File resource allows you to create and manage YAML files using AI models. It can generate YAML content based on a prompt and optionally validate it against a schema. For more information on YAML, visit [YAML's official website](https://yaml.org/).

# Minimal Example

```ts
import { YAMLFile } from "alchemy/ai";

const serverlessConfig = await YAMLFile("serverless-config", {
  path: "./serverless.yml",
  prompt: "Generate a basic serverless configuration for AWS Lambda.",
});
```

# Create the YAML File

```ts
import { YAMLFile } from "alchemy/ai";
import { type } from "arktype";

const k8sConfigSchema = type({
  apiVersion: "string",
  kind: "string",
  metadata: {
    name: "string",
    namespace: "string?",
    labels: "Record<string, string>?"
  },
  spec: {
    replicas: "number",
    selector: {
      matchLabels: "Record<string, string>"
    },
    template: {
      metadata: {
        labels: "Record<string, string>"
      },
      spec: {
        containers: [{
          name: "string",
          image: "string",
          ports: [{
            containerPort: "number"
          }]
        }]
      }
    }
  }
});

const deployment = await YAMLFile("k8s-deployment", {
  path: "./kubernetes/deployment.yaml",
  schema: k8sConfigSchema,
  prompt: "Generate a Kubernetes deployment for a web application named 'frontend' with 3 replicas using the nginx:latest image and exposing port 80",
  temperature: 0.2
});
```