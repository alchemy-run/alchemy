# Data

The Data component allows you to generate structured content using AI models, validated against a specified schema. This resource is part of the Alchemy AI service, which leverages AI to automate content generation tasks. For more information, visit the [Alchemy AI documentation](https://alchemy.com/ai).

# Minimal Example

```ts
import { Data } from "alchemy/ai";

const productSchema = type({
  name: "string",
  description: "string",
  price: "number"
});

const productData = await Data("product-info", {
  schema: productSchema,
  prompt: "Generate a product description for a new smartphone",
  system: "You are a product copywriter specializing in tech products"
});
```

# Create the Data

```ts
import { Data } from "alchemy/ai";

const userSchema = type({
  id: "string",
  name: "string",
  email: "string",
  role: "'admin' | 'user' | 'guest'",
  active: "boolean"
});

const userData = await Data("user-data", {
  schema: userSchema,
  prompt: "Generate sample user data for an application with various roles and permissions",
  system: "You are a data generator for user profiles",
  temperature: 0.2
});

console.log(userData.object); // Access the generated data
```