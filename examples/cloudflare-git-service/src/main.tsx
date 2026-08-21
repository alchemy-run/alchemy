/**
 * A GitHub-style browser for the deployed git-service — a plain React SPA
 * (no framework router, no Effect in the bundle) that drives the service's
 * REST API (`/api/v1`) with a bearer token.
 *
 * Routes (GitHub-shaped):
 *
 *   /                                → repository list
 *   /:owner/:repo                    → code view (tree @ default branch)
 *   /:owner/:repo/tree/:ref/*path    → tree at path
 *   /:owner/:repo/blob/:ref/*path    → file view
 *   /:owner/:repo/commits/:ref       → commit log
 *   /:owner/:repo/commit/:oid        → one commit: message + file diffs
 *   /:owner/:repo/pulls              → pull requests (open/closed/merged)
 *   /:owner/:repo/pulls/:number      → one pull request: merge box + diffs
 *   /:owner/:repo/settings           → tokens / storage / danger zone
 */
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { getConnection, signOut } from "./api.ts";
import { RepoIcon, ThemeToggle } from "./components.tsx";
import { ConnectPage } from "./pages/Connect.tsx";
import { RepoPage } from "./pages/Repo.tsx";
import { ReposPage } from "./pages/Repos.tsx";
import { Link, Router, segments, useRouter } from "./router.tsx";
import "./styles.css";
import { ThemeProvider } from "./theme.tsx";

const Header = ({
  onSignIn,
  onSignOut,
}: {
  onSignIn: () => void;
  onSignOut: () => void;
}) => {
  const connection = getConnection();
  const signedIn = connection?.token !== undefined;
  return (
    <header className="border-b border-border-muted bg-canvas-subtle">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <RepoIcon className="size-5" />
          git service
        </Link>
        <div className="flex items-center gap-3 text-xs text-fg-muted">
          <ThemeToggle />
          {connection !== null && (
            <span className="hidden font-mono sm:inline">
              {new URL(connection.url).host}
            </span>
          )}
          {signedIn ? (
            <button
              type="button"
              onClick={onSignOut}
              className="cursor-pointer rounded-md border border-border-muted px-2 py-1 hover:text-danger"
            >
              Sign out
            </button>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              className="cursor-pointer rounded-md border border-border-muted px-2 py-1 hover:text-accent"
            >
              Sign in
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

const Routes = () => {
  const { path } = useRouter();
  // Re-render the app when the connection changes (sign in / sign out).
  const [, setGeneration] = useState(0);
  const [showSignIn, setShowSignIn] = useState(false);
  const connection = getConnection();

  // Browsing is ANONYMOUS by default — public repos need no token. The
  // connect screen appears only when no service URL is known at all, or
  // when the user explicitly opens Sign in (for admin/private access).
  if (connection === null || showSignIn) {
    return (
      <ConnectPage
        onConnected={() => {
          setShowSignIn(false);
          setGeneration((n) => n + 1);
        }}
      />
    );
  }

  const parts = segments(path);
  return (
    <>
      <Header
        onSignIn={() => setShowSignIn(true)}
        onSignOut={() => {
          signOut();
          setGeneration((n) => n + 1);
        }}
      />
      <main className="mx-auto max-w-5xl px-4 py-6">
        {parts.length === 0 ? (
          <ReposPage connection={connection} />
        ) : parts.length >= 2 ? (
          <RepoPage
            connection={connection}
            owner={parts[0]!}
            name={parts[1]!.replace(/\.git$/, "")}
            rest={parts.slice(2)}
          />
        ) : (
          <div className="py-16 text-center text-fg-muted">Not found.</div>
        )}
      </main>
    </>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Router>
        <Routes />
      </Router>
    </ThemeProvider>
  </React.StrictMode>,
);
