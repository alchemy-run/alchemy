# Vue File

The Vue File resource lets you generate [Vue.js](https://vuejs.org/) components using AI models.

# Minimal Example

Creates a basic Vue component file.

```ts
import { VueFile } from "alchemy/ai";

const button = await VueFile("button", {
  path: "./src/components/Button.vue",
  prompt: "Create a reusable button component with primary and secondary variants"
});
```

# Create a Vue Component with Context

```ts
import { VueFile } from "alchemy/ai";

const userCard = await VueFile("user-card", {
  path: "./src/components/UserCard.vue",
  prompt: await alchemy`
    Create a UserCard component using:
    ${alchemy.file("src/types/User.ts")}
    ${alchemy.file("src/styles/card.css")}
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```

# Generate a Form Component

```ts
import { VueFile } from "alchemy/ai";

const form = await VueFile("registration-form", {
  path: "./src/components/RegistrationForm.vue", 
  prompt: "Create a registration form with email, password validation and submit handler",
  system: "You are a Vue expert specializing in form components with validation",
  temperature: 0.2
});
```