# VueFile

The VueFile resource lets you generate [Vue.js](https://vuejs.org/) components using AI models.

# Minimal Example

Creates a basic Vue component file:

```ts
import { VueFile } from "alchemy/ai";

const button = await VueFile("button", {
  path: "./src/components/Button.vue",
  prompt: "Generate a reusable button component with primary and secondary variants"
});
```

# With Context From Existing Files

Generates a component using existing files as reference:

```ts
import { VueFile } from "alchemy/ai";

const userCard = await VueFile("user-card", {
  path: "./src/components/UserCard.vue",
  prompt: await alchemy`
    Create a UserCard component following the style from:
    ${alchemy.file("src/components/Card.vue")}
    
    Using the types from:
    ${alchemy.file("src/types/User.ts")}
  `
});
```

# With Custom System Prompt

Provides specific instructions to the AI model:

```ts
import { VueFile } from "alchemy/ai";

const form = await VueFile("login-form", {
  path: "./src/components/LoginForm.vue",
  prompt: "Generate a login form with email/password fields and validation",
  system: "You are a Vue expert specializing in form components. Create a single Vue component inside ```vue fences with proper TypeScript types.",
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```