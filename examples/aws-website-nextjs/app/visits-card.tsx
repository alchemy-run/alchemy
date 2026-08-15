"use client";

import { useState, useTransition } from "react";
import { bumpVisits } from "./actions";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";

// The browser side of the counter: the button calls the `bumpVisits`
// server action (Next's transport — this module imports ONLY ./actions,
// never the backend). The count bumps optimistically and reconciles with
// the authoritative value the action returns.
export default function VisitsCard({ initial }: { initial: number }) {
  const [bumped, setBumped] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Visits</CardTitle>
        <CardDescription>
          Server-rendered visits: <span data-testid="count">{initial}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setBumped((n) => (n ?? initial) + 1); // optimistic
              setBumped(await bumpVisits()); // authoritative
            })
          }
        >
          Bump visits
        </Button>
        {bumped !== null && (
          <p className="mt-4 text-sm text-muted-foreground" data-testid="bumped">
            Client bump →{" "}
            <span className="font-medium text-foreground">{bumped}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
