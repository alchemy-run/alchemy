# Data

The Data resource lets you generate structured content using [AI models](https://platform.openai.com/docs/api-reference) with schema validation.

# Minimal Example

Generate structured data using an ArkType schema:

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const schema = type({
  name: "string",
  description: "string",
  features: "string[]"
});

const product = await Data("product", {
  schema,
  prompt: "Generate a product description for a smartphone"
});

console.log(product.object); // Typed as per schema
```

# Generate with Context

Use alchemy template literals to include file context:

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const docSchema = type({
  summary: "string", 
  parameters: [{
    name: "string",
    type: "string",
    description: "string"
  }],
  returns: "string"
});

const docs = await Data("function-docs", {
  schema: docSchema,
  prompt: await alchemy`
    Generate documentation for this function:
    ${alchemy.file("src/utils/format.ts")}
  `,
  system: "You are a technical documentation writer",
  temperature: 0.2
});
```