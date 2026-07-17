/// <reference types="vite/client" />

// Typed Vite env vars exposed to the client bundle (P2 operator key).
interface ImportMetaEnv {
  /** P2 — operator route gate; sent as X-Operator-Key. Blank/undefined in dev. */
  readonly VITE_OPERATOR_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
