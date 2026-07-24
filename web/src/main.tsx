import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.js";
import { ThemeProvider } from "./theme-mode";
import "reactflow/dist/style.css";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The dashboard is observability — stale data is fine briefly; we refetch
      // on an interval. Don't spam refetches on window focus.
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
