import type * as React from "react";
import { cn } from "../../lib/utils";

const variants = {
  default: "bg-slate-900 text-slate-50 hover:bg-slate-900/90",
  outline: "border border-slate-200 bg-white text-slate-900 hover:bg-slate-100",
} as const;

export function Button({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"button"> & { variant?: keyof typeof variants }) {
  return (
    <button
      data-slot="button"
      className={cn(
        "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
