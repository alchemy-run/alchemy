# Function

**Type:** `AWS.Lambda.Function`

## Props

| Property     | Type                           | Required | Default | Description |
| ------------ | ------------------------------ | -------- | ------- | ----------- |
| functionName | `string`                       | No       | -       | -           |
| functionArn  | `string`                       | No       | -       | -           |
| main         | `string`                       | Yes      | -       | -           |
| handler      | `string`                       | No       | -       | -           |
| memory       | `number`                       | No       | -       | -           |
| runtime      | `"nodejs20.x" \| "nodejs22.x"` | No       | -       | -           |
| architecture | `"x86_64" \| "arm64"`          | No       | -       | -           |
| url          | `boolean`                      | No       | -       | -           |

## Capabilities

### InvokeFunction

**Type:** `AWS.Lambda.InvokeFunction`

#### Functions

- `invoke(...)`
