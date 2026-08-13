"use client";

import { useEffect, useState } from "react";

// Calls the Effect API served by this same Worker — src/backend.ts owns /api/*
// and backs it with a KV namespace.
export default function Visits() {
  const [visits, setVisits] = useState(null);
  useEffect(() => {
    fetch("/api/visits")
      .then((res) => res.json())
      .then((body) => setVisits(body.visits))
      .catch(() => {});
  }, []);
  return (
    <p className="mt-2 text-sm text-gray-500">
      {visits === null
        ? "Loading visits…"
        : `This page has been visited ${visits} times.`}
    </p>
  );
}
