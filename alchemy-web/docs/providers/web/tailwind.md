# TailwindConfig

The TailwindConfig resource allows you to configure [Tailwind CSS](https://tailwindcss.com/) for your project, supporting various frameworks like Vite, Astro, and standalone setups.

# Minimal Example

```ts
import { TailwindConfig } from "alchemy/web";

const tailwind = await TailwindConfig("my-tailwind-config", {
  cwd: "my-project",
});
```

# Create the TailwindConfig

```ts
import { TailwindConfig } from "alchemy/web";

// Install Tailwind for a Vite project
const viteTailwind = await TailwindConfig("vite-tailwind", {
  cwd: "my-vite-app",
  framework: "vite",
});

// Install Tailwind for an Astro project
const astroTailwind = await TailwindConfig("astro-tailwind", {
  cwd: "my-astro-app",
  framework: "astro",
});

// Install Tailwind as standalone with additional packages
const standaloneTailwind = await TailwindConfig("standalone-tailwind", {
  cwd: "my-standalone-app",
  additionalPackages: ["@tailwindcss/typography", "@tailwindcss/forms"],
});
```