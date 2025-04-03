# Vue File

The VueFile component allows you to generate and manage Vue components using AI models. It extracts Vue code from AI-generated responses and ensures the code is properly formatted and validated. Learn more about Vue.js at [Vue.js Official Website](https://vuejs.org/).

# Minimal Example

```ts
import { VueFile } from "alchemy/ai";

const button = await VueFile("button-component", {
  path: "./src/components/Button.vue",
  prompt: await alchemy`
    Generate a customizable button Vue component with:
    - Primary, secondary, and outline variants
    - Small, medium, and large sizes
    - Loading state with spinner
    - Disabled state
  `,
  model: {
    id: "gpt-4o",
    provider: "openai"
  }
});
```

# Create the Vue File

```ts
import { VueFile } from "alchemy/ai";

const userCard = await VueFile("user-card", {
  path: "./src/components/UserCard.vue",
  prompt: await alchemy`
    Create a UserCard Vue component that displays user information.
    Follow the styling patterns from:
    ${alchemy.file("src/components/Card.vue")}

    Use the user type from:
    ${alchemy.file("src/types/User.ts")}
  `,
  temperature: 0.2
});
```