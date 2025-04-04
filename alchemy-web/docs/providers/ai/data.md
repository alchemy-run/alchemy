# AI Data

The Data resource lets you generate structured content using [AI models](https://platform.openai.com/docs/models) with schema validation.

# Minimal Example

Generate structured data using an ArkType schema.

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const schema = type({
  name: "string",
  description: "string",
  features: "string[]"
});

const data = await Data("product", {
  schema,
  prompt: "Generate a product description for a smartphone"
});

console.log(data.object); // Typed according to schema
```

# Generate with Message History

Use message history for iterative content generation.

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const schema = type({
  summary: "string", 
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

# Custom Model Configuration

Configure the AI model and generation parameters.

```ts
import { Data } from "alchemy/ai";
import { type } from "arktype";

const schema = type({
  title: "string",
  sections: [{
    heading: "string",
    content: "string"
  }]
});

const docs = await Data("api-docs", {
  schema,
  prompt: await alchemy`
    Generate documentation for:
    ${alchemy.file("src/api.ts")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai",
    options: {
      temperature: 0.2
    }
  }
});
```