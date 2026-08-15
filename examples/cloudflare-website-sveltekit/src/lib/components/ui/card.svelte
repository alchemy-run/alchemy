<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "../../utils.ts";

  let {
    class: className,
    children,
    ...rest
  }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
  class={cn(
    "flex flex-col gap-6 rounded-lg border bg-card py-6 text-card-foreground shadow-sm",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</div>
