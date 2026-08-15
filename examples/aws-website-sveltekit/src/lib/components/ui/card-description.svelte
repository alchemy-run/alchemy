<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "../../utils.ts";

  let {
    class: className,
    children,
    ...rest
  }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn("text-sm text-muted-foreground", className)} {...rest}>
  {@render children?.()}
</div>
