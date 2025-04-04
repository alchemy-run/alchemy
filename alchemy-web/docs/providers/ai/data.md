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

# Create Data with Message History

Use message history for iterative content generation:

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const schema = type({
  rating: "number",
  feedback: "string",
  improvements: "string[]"
});

const feedback = await Data("feedback", {
  schema,
  messages: [
    { role: "user", content: "Review my product design" },
    { role: "assistant", content: "I'll help review it. What's the product?" },
    { role: "user", content: "It's a smart home device that..." }
  ],
  system: "You are a product design expert providing structured feedback"
});
```

# Generate Data with File Context

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
  temperature: 0.2
});
```