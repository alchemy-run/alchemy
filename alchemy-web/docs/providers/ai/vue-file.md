# Vue File

The Vue File resource lets you generate [Vue.js](https://vuejs.org/) components using AI models. It extracts Vue code from between ```vue fences and validates the response.

# Minimal Example

Creates a basic Vue component file.

```ts
import { VueFile } from "alchemy/ai";

const button = await VueFile("button", {
  path: "./src/components/Button.vue",
  prompt: "Generate a simple button component with primary and secondary variants"
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
  prompt: await alchemy`
    Generate a registration form with:
    - Email and password fields
    - Form validation
    - Submit handler
    - Loading state
  `,
  system: "Create a Vue form component with validation and error handling",
  temperature: 0.2
});
```