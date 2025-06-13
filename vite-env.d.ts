
// vite-env.d.ts

// This file provides type definitions for Vite-specific environment variables
// accessible via `import.meta.env`.

// By defining these interfaces here, we provide the necessary types directly.
// This should resolve errors related to `import.meta.env` in other files (like firebase.ts)
// and addresses the issue of the unresolvable reference by providing the types manually.

interface ImportMetaEnv {
  /**
   * Indicates if the application is running in development mode.
   * Set by Vite.
   */
  readonly DEV: boolean;

  /**
   * Indicates if the application is running in production mode.
   * Set by Vite.
   */
  readonly PROD: boolean;

  /**
   * The mode the application is running in (e.g., 'development', 'production').
   * Set by Vite.
   */
  readonly MODE: string;

  /**
   * The base URL the app is being served from.
   * Set by Vite.
   */
  readonly BASE_URL: string;

  /**
   * Indicates if the code is running in an SSR context.
   * Set by Vite.
   */
  readonly SSR: boolean;

  // You can add other custom environment variables prefixed with VITE_
  // e.g., readonly VITE_API_URL: string;
  // readonly VITE_MY_VARIABLE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
