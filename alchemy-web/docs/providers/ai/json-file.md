# JSONFile

The JSONFile Resource lets you generate JSON files using AI models. It supports both schema-based generation with [ArkType](https://github.com/arktypeio/arktype) validation and freeform JSON generation.

# Minimal Example

Generate a simple JSON configuration file:

```ts
import { JSONFile } from "alchemy/ai";

const config = await JSONFile("app-config", {
  path: "./config/app.json",
  prompt: "Generate a configuration for a web application with server settings, database connection details, and feature flags"
});
```

# Create with Schema Validation 

Generate JSON with type safety using an ArkType schema:

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