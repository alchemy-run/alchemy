# JSON File

The JSON File resource lets you generate JSON files using AI models. It supports both schema-based generation with [ArkType](https://arktype.io/) validation and freeform JSON generation.

# Minimal Example

Creates a simple JSON configuration file.

```ts
import { JSONFile } from "alchemy/ai";

const config = await JSONFile("app-config", {
  path: "./config/app.json",
  prompt: "Generate a configuration for a web application with server settings, database connection details, and logging configuration"
});
```

# Create with Schema Validation

Uses ArkType schema to validate and structure the generated JSON.

```ts
import { JSONFile } from "alchemy/ai";
import { type } from "arktype";

const userSchema = type({
  users: [{
    id: "string",
    name: "string", 
    email: "string",
    role: "'admin' | 'user' | 'guest'",
    permissions: "string[]",
    active: "boolean"
  }]
});

const userData = await JSONFile("user-data", {
  path: "./data/users.json",
  schema: userSchema,
  prompt: "Generate sample user data with various roles and permissions",
  temperature: 0.2
});
```

# Generate API Mock Data

Creates realistic mock data for API testing.

```ts
import { JSONFile } from "alchemy/ai";

const apiMock = await JSONFile("api-mock", {
  path: "./mocks/products-api.json", 
  prompt: "Create mock data for a product catalog API with 10 products including id, name, price, category, inventory and pagination metadata",
  system: "You are an API design expert. Create realistic mock JSON data following REST API best practices.",
  pretty: true,
  indent: 4
});
```