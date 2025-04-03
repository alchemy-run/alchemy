# JSON File

The JSON File resource allows you to create, update, and manage JSON files using AI-generated content. It can validate and structure the generated JSON using an optional schema. Learn more about JSON at [JSON.org](https://www.json.org/).

# Minimal Example

```ts
import { JSONFile } from "alchemy/ai";

const config = await JSONFile("app-config", {
  path: "./config/app.json",
  prompt: "Generate a basic configuration for a web application.",
});
```

# Create the JSON File

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
  prompt: "Generate sample user data for an application with various roles and permissions",
  temperature: 0.2
});

console.log(userData.json.users[0].role); // Typed as 'admin' | 'user' | 'guest'
```