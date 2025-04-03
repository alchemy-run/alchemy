# Vue File

The Vue File resource lets you generate [Vue.js](https://vuejs.org/) components using AI models.

# Minimal Example

Creates a basic Vue component file with the specified content.

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
    Create a UserCard component that displays user info.
    Use the types from: ${alchemy.file("src/types/User.ts")}
    Follow the styling from: ${alchemy.file("src/styles/card.css")}
  `,
  temperature: 0.2
});
```

# Create a Form Component with Custom System Prompt

```ts
import { VueFile } from "alchemy/ai";

const form = await VueFile("registration-form", {
  path: "./src/components/RegistrationForm.vue",
  prompt: "Generate a registration form with email, password and validation",
  system: "You are a Vue expert specializing in form components. Create a single Vue component inside ```vue fences.",
  model: {
    id: "gpt-4",
    provider: "openai"
  }
});
```