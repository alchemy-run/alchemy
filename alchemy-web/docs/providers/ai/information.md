# Information

The Information component allows you to generate structured content using AI, based on a specified schema. It leverages the Vercel AI SDK for content generation. For more details, visit the [Vercel AI SDK documentation](https://vercel.com/docs/ai).

# Minimal Example

```ts
import { Information } from "alchemy/ai";

const productSchema = type({
  name: "string",
  description: "string",
  features: "string[]",
  price: "number"
});

const productInfo = await Information("product-info", {
  schema: productSchema,
  prompt: "Generate a product description for a new smartphone",
  system: "You are a product copywriter specializing in tech products"
});

console.log(productInfo.object);
```

# Create the Information

```ts
import { Information } from "alchemy/ai";

const docSchema = type({
  summary: "string",
  parameters: {
    name: "string",
    type: "string",
    description: "string"
  }[],
  returns: "string"
});

const functionDocs = await Information("function-docs", {
  schema: docSchema,
  prompt: await alchemy`
    Generate documentation for this function:
    ${alchemy.file("src/utils/format.ts")}
  `,
  system: "You are a technical documentation writer"
});

console.log(functionDocs.object);
```