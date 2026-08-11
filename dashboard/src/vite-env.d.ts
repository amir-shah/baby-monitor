/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the babymon API, e.g. `http://nursery.local:8080`.
   * Leave unset for the normal deployment, where the API serves this bundle
   * and every request is same-origin (and the dev server proxies `/api`).
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
