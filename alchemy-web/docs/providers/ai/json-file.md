# JSON File

The JSON File resource lets you generate JSON files using AI models. It supports both schema-based generation with [ArkType](https://arktype.io/) validation and freeform JSON generation.

# Minimal Example

Generate a simple JSON configuration file:

```ts
import { JSONFile } from "alchemy/ai";

const config = await JSONFile("app-config", {
  path: "./config/app.json",
  prompt: "Generate a configuration for a web application with server settings, database connection details, and feature flags"
});
```

# Generate JSON with Schema Validation 

Use ArkType schemas to ensure type-safe JSON generation:

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

// Type-safe access to generated data
console.log(userData.json.users[0].role); // Typed as 'admin' | 'user' | 'guest'
```

# Generate API Mock Data

Create realistic mock data for API development:

```ts
import { JSONFile } from "alchemy/ai";

const apiMock = await JSONFile("api-mock", {
  path: "./mocks/products-api.json",
  prompt: await alchemy`
    Create mock data for a product catalog API response with:
    - 10 products with different categories
    - Each product should have id, name, price, category, inventory, and image_url
    - Include pagination metadata (total, page, limit)
  `,
  system: "You are an API design expert. Create realistic mock JSON data that follows REST API best practices.",
  model: {
    id: "claude-3-opus-20240229",
    provider: "anthropic"
  },
  pretty: true,
  indent: 4
});
```