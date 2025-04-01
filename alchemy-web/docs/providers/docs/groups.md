# Group

The Group resource allows you to use AI to identify distinct groups from a given prompt, leveraging the Vercel AI SDK. This resource supports powerful context handling through the Alchemy template literal tag.

# Minimal Example

```ts twoslash
import { Groups } from "alchemy/docs";

const dataGroups = await Groups("data-groups", {
  categories: ["User", "Post"],
  prompt: await alchemy`
    Identify distinct groups in this data:
    ${alchemy.file("src/data.ts")}
    Classify as either "User" or "Post"
  `
});

console.log(dataGroups.groups); // ["group1", "group2", ...]
```

# Create the Group

```ts twoslash
import { Groups } from "alchemy/docs";

const modelGroups = await Groups("model-groups", {
  categories: ["User", "Post"],
  prompt: await alchemy`
    Identify distinct groups in these models:
    ${alchemy.files("src/models/user.ts", "src/models/post.ts")}
    Classify as either "User" or "Post"
  `
});

console.log(modelGroups.groups); // Outputs the identified groups with their categories
```