# AstroProject

The AstroProject component allows you to create and manage an [Astro](https://astro.build/) project with various integrations and configurations.

# Minimal Example

```ts
import { AstroProject } from "alchemy/web";

const basicProject = await AstroProject("my-astro-app", {
  title: "My Astro Site",
  description: "Built with Alchemy"
});
```

# Create the AstroProject

```ts
import { AstroProject } from "alchemy/web";

// Create an Astro project with React and Tailwind
const reactProject = await AstroProject("astro-react", {
  title: "Astro + React",
  integrations: ["react", "tailwind"]
});

// Create an Astro project with Shadcn UI
const shadcnProject = await AstroProject("astro-shadcn", {
  title: "Astro with Shadcn UI",
  integrations: ["react", "tailwind"],
  shadcn: {
    baseColor: "zinc",
    components: ["button", "card", "input"]
  }
});
```