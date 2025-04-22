# Data

The Data resource uses AI models to generate structured content based on a schema. It leverages the [Vercel AI SDK](https://sdk.vercel.ai/docs) for type-safe content generation.

## Minimal Example

Generate structured data using an ArkType schema:

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const productSchema = type({
  name: "string",
  description: "string", 
  features: "string[]",
  price: "number"
});

const product = await Data("new-product", {
  schema: productSchema,
  prompt: "Generate a product description for a new smartphone"
});

console.log(product.object); // Typed as per schema
```

## Using Message History

Generate content iteratively using conversation history:

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const feedbackSchema = type({
  rating: "number",
  positives: "string[]",
  improvements: "string[]",
  summary: "string"
});

const feedback = await Data("product-feedback", {
  schema: feedbackSchema,
  messages: [
    { role: "user", content: "I'd like feedback on my product design" },
    { role: "assistant", content: "I'd be happy to provide feedback. What's your product?" },
    { role: "user", content: "It's a new smart home device that..." }
  ],
  system: "You are a product design expert providing structured feedback"
});
```

## Using File Context

Generate documentation using file context:

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

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
```