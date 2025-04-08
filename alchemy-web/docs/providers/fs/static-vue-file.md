# StaticVueFile

The StaticVueFile resource creates [Vue single-file components](https://vuejs.org/guide/scaling-up/sfc.html) with template, script and style blocks.

# Minimal Example

Create a basic Vue component file with a template.

```ts
import { StaticVueFile } from "alchemy/fs";

const component = await StaticVueFile("Button.vue", `
<template>
  <button>Click me</button>
</template>
`);
```

# Create a Full Component

Create a Vue component with template, script and scoped styles.

```ts
import { StaticVueFile } from "alchemy/fs";

const button = await StaticVueFile("Button.vue", `
<template>
  <button class="btn" @click="handleClick">
    {{ text }}
  </button>
</template>

<script>
export default {
  props: {
    text: {
      type: String,
      required: true
    }
  },
  methods: {
    handleClick() {
      this.$emit('click')
    }
  }
}
</script>

<style scoped>
.btn {
  padding: 0.5rem 1rem;
  border-radius: 4px;
  background: #42b883;
  color: white;
}
</style>
`);
```