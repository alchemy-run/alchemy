# Ark

The Ark component provides a structured way to define and validate JSON schemas using [ArkType](https://arktype.io/). It allows you to create tools with specific input and output types, ensuring that your data adheres to the defined schema.

# Minimal Example

```ts
import { ark } from "alchemy/ai";

const mySchema = ark.schema({
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
  },
  required: ["name", "age"],
});

console.log(mySchema);
```

# Create the Ark

```ts
import { ark } from "alchemy/ai";

const myTool = ark.tool({
  name: "ExampleTool",
  description: "A tool that processes user data",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string" },
      action: { type: "string" },
    },
    required: ["userId", "action"],
  },
  execute: async (input, options) => {
    // Process the input
    return { success: true, message: `Processed action: ${input.action}` };
  },
});

console.log(myTool);
```