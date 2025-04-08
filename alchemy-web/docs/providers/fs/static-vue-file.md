# Static Vue File

The Static Vue File resource lets you create and manage [Vue.js](https://vuejs.org/) single-file component files (.vue) in your project.

# Minimal Example

Creates a basic Vue component file with template, script and style sections.

```ts
import { StaticVueFile } from "alchemy/fs";

const button = await StaticVueFile("Button.vue", `
<template>
  <button class="btn">{{ text }}</button>
</template>

<script>
export default {
  props: {
    text: String
  }
}
</script>

<style>
.btn {
  padding: 0.5rem 1rem;
}
</style>
`);
```

# Create with Custom Path

Creates a Vue component file at a specific path location.

```ts
import { StaticVueFile } from "alchemy/fs";

const header = await StaticVueFile("Header", 
  "components/Header.vue",
  `<template>
    <header>
      <h1>{{ title }}</h1>
      <nav>
        <slot></slot>
      </nav>
    </header>
  </template>

  <script>
  export default {
    props: {
      title: String
    }
  }
  </script>
`);
```