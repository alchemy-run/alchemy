# Data

The Data component allows you to generate structured content using AI based on a defined schema. It leverages the Vercel AI SDK for content generation, supporting advanced context handling and model configuration.

# Minimal Example

```ts
import { Data } from "alchemy/ai";

const productSchema = type({
  name: "string",
  description: "string",
  features: "string[]",
  price: "number"
});

const product = await Data("new-product", {
  schema: productSchema,
  prompt: "Generate a product description for a new smartphone",
  system: "You are a product copywriter specializing in tech products",
  model: {
    id: "gpt-4o",
    provider: "openai",
    options: {
      temperature: 0.7
    }
  }
});

console.log(product.object); // Typed as per schema
```

# Create the Data

```ts
import { Data } from "alchemy/ai";

const analysisSchema = type({
  insights: "string[]",
  recommendations: "string[]",
  risk: "'low'|'medium'|'high'"
});

const analysis = await Data("code-analysis", {
  schema: analysisSchema,
  prompt: await alchemy`
    Analyze this code for security issues:
    ${alchemy.file("src/auth/login.ts")}
  `,
  system: "You are a security expert specializing in code analysis",
  model: {
    id: "o3-mini",
    provider: "openai",
    options: {
      reasoningEffort: "high"
    }
  },
  temperature: 0.1
});
```