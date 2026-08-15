import type { ReactNode } from "react";
import { Link } from "waku";

// Global stylesheet — Tailwind CSS v4 + the shadcn-style design tokens,
// compiled by the @tailwindcss/vite plugin registered in waku.config.ts.
import "../styles.css";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <nav className="mb-8 flex items-center gap-6 text-sm font-medium">
        <Link to="/" className="transition-colors hover:text-muted-foreground">
          Home
        </Link>
        <Link
          to="/about"
          className="transition-colors hover:text-muted-foreground"
        >
          About
        </Link>
      </nav>
      {children}
    </div>
  );
}

export const getConfig = async () => ({ render: "static" }) as const;
