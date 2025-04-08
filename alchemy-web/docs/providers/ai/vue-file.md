# VueFile

The VueFile resource lets you generate [Vue.js](https://vuejs.org/) component files using AI models.

# Minimal Example

Creates a basic Vue component file with AI-generated code.

```ts
import { VueFile } from "alchemy/ai";

const button = await VueFile("button", {
  path: "./src/components/Button.vue",
  prompt: "Generate a reusable button component with primary and secondary variants"
});
```

# Create a Vue Component with Context

Generates a Vue component using existing files as reference.

```ts
import { VueFile } from "alchemy/ai";

const userCard = await VueFile("user-card", {
  path: "./src/components/UserCard.vue",
  prompt: await alchemy`
    Create a UserCard component that follows the styling from:
    ${alchemy.file("src/components/Card.vue")}
    
    Using the user type from:
    ${alchemy.file("src/types/User.ts")}
  `,
  temperature: 0.2
});
```