# Data

The Data component allows you to generate structured content using AI based on a specified schema. It leverages the Vercel AI SDK to create content that adheres to a given structure, making it ideal for generating consistent and validated outputs. Learn more about [Vercel AI SDK](https://vercel.com/docs/ai).

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
  system: "You are a product copywriter specializing in tech products"
});

console.log(product.object); // Typed as per schema
```

# Create the Data

```ts
import { Data } from "alchemy/ai";

const docSchema = type({
  summary: "string",
  parameters: {
    name: "string",
    type: "string",
    description: "string"
  }[],
  returns: "string"
});

const docs = await Data("function-docs", {
  schema: docSchema,
  prompt: await alchemy`
    Generate documentation for this function:
    ${alchemy.file("src/utils/format.ts")}
  `,
  system: "You are a technical documentation writer"
});

console.log(docs.object); // Typed as per schema
```