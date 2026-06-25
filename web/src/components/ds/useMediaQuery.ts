// useMediaQuery — subscribe to a CSS media query (responsive layout switches).
// Presentational helper only; no data dependencies.
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && "matchMedia" in window
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

// Shared breakpoints for the redesign (desktop / large-laptop / tablet).
export const bp = {
  tablet: "(max-width: 900px)",
  laptop: "(max-width: 1280px)",
} as const;
