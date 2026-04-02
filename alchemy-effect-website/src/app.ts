type PagefindResult = {
  url: string;
  excerpt: string;
  meta: {
    title?: string;
  };
};

type PagefindSearchResponse = {
  results: Array<{
    data: () => Promise<PagefindResult>;
  }>;
};

type PagefindModule = {
  options(options: { bundlePath: string }): Promise<void>;
  init(): Promise<void>;
  debouncedSearch(
    term: string,
    options?: Record<string, unknown>,
    debounceTimeoutMs?: number,
  ): Promise<PagefindSearchResponse | null>;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const classifyUrl = (url: string) => {
  if (url.startsWith("/reference/")) {
    return {
      label: "API Reference",
      classes:
        "border-violet-200/20 bg-violet-200/10 text-violet-100",
    };
  }

  return {
    label: "Guide",
    classes:
      "border-violet-400/20 bg-violet-400/10 text-violet-200",
  };
};

let pagefindPromise: Promise<PagefindModule> | undefined;
const dynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<unknown>;

const loadPagefind = async () => {
  if (!pagefindPromise) {
    pagefindPromise = (async () => {
      const pagefind = (await dynamicImport(
        "/pagefind/pagefind.js",
      )) as PagefindModule;
      await pagefind.options({
        bundlePath: "/pagefind/",
      });
      await pagefind.init();
      return pagefind;
    })();
  }

  return pagefindPromise;
};

const modal = document.querySelector<HTMLElement>("#search-modal");
const input = document.querySelector<HTMLInputElement>("#search-input");
const results = document.querySelector<HTMLElement>("#search-results");
const status = document.querySelector<HTMLElement>("#search-status");
const backdrop = document.querySelector<HTMLElement>("[data-search-backdrop]");
const openButtons = Array.from(
  document.querySelectorAll<HTMLElement>("[data-search-open]"),
);

if (modal && input && results && status && backdrop) {
  let isOpen = false;

  const setStatus = (message: string) => {
    status.textContent = message;
  };

  const openSearch = async () => {
    if (isOpen) return;
    isOpen = true;
    modal.classList.remove("hidden");
    document.body.classList.add("overflow-hidden");
    setStatus("Loading search index...");
    results.innerHTML = "";
    input.value = "";
    input.focus();
    await loadPagefind();
    setStatus("Start typing to search the docs.");
  };

  const closeSearch = () => {
    if (!isOpen) return;
    isOpen = false;
    modal.classList.add("hidden");
    document.body.classList.remove("overflow-hidden");
  };

  const renderResults = (items: PagefindResult[]) => {
    if (items.length === 0) {
      results.innerHTML = "";
      setStatus("No results matched that search.");
      return;
    }

    setStatus(`Showing ${items.length} result${items.length === 1 ? "" : "s"}.`);
    results.innerHTML = items
      .map((item) => {
        const badge = classifyUrl(item.url);
        return `
          <a href="${item.url}" class="block px-5 py-4 transition hover:bg-white/[0.06]">
            <div class="mb-2 flex items-center gap-3">
              <span class="inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${badge.classes}">
                ${badge.label}
              </span>
              <span class="text-xs text-slate-500">${escapeHtml(item.url)}</span>
            </div>
            <div class="text-base font-semibold text-white">
              ${escapeHtml(item.meta.title ?? item.url)}
            </div>
            <p class="mt-2 text-sm leading-6 text-slate-300">${item.excerpt}</p>
          </a>
        `;
      })
      .join("");
  };

  const runSearch = async (term: string) => {
    const normalized = term.trim();
    if (!normalized) {
      results.innerHTML = "";
      setStatus("Start typing to search the docs.");
      return;
    }

    setStatus(`Searching for "${normalized}"...`);
    const pagefind = await loadPagefind();
    const search = await pagefind.debouncedSearch(normalized, {}, 200);
    if (!search) {
      return;
    }

    const data = await Promise.all(
      search.results.slice(0, 8).map((result) => result.data()),
    );
    renderResults(data);
  };

  openButtons.forEach((button) => {
    button.addEventListener("click", () => {
      void openSearch();
    });
  });

  backdrop.addEventListener("click", closeSearch);

  input.addEventListener("input", () => {
    void runSearch(input.value);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void openSearch();
      return;
    }

    if (event.key === "/" && document.activeElement !== input) {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      event.preventDefault();
      void openSearch();
      return;
    }

    if (event.key === "Escape") {
      closeSearch();
    }
  });
}
