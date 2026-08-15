"use client";

import { useState } from "react";
import { Button } from "./ui/button.tsx";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div className="flex items-center gap-3">
      <Button
        data-testid="counter"
        onClick={() => setCount((value) => value + 1)}
      >
        Increment
      </Button>
      <span className="text-sm text-muted-foreground">count: {count}</span>
    </div>
  );
}
