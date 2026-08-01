/**
 * lib/api.ts — Centralized API client for EzyPrint REST backend.
 *
 * Replaces all direct Firebase SDK calls (Firestore, Auth, Storage, Cloud Functions)
 * with standard fetch() calls to the Express backend.
 *
 * Features:
 * - Automatic JWT token injection via Authorization header
 * - Automatic 401 → refresh token → retry logic
 * - Typed request/response helpers
 * - Base URL from environment variable
 */

// ── Token Storage (in-memory for security) ──
let accessToken: string | null = null;
let refreshToken: string | null = null;

// Persist refresh token across page reloads via localStorage
const REFRESH_TOKEN_KEY = 'ezyprint_refresh_token';

export function getAccessToken(): string | null {
  return accessToken;
}

export function setTokens(access: string, refresh: string): void {
  accessToken = access;
  refreshToken = refresh;
  try {
    localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
  } catch {
    // localStorage not available (SSR, private browsing) — tokens live in memory only
  }
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function loadRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

// ── Base URL ──
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5001/api/v1';

// ── Types ──
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ── Refresh logic ──
let refreshPromise: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  const rt = refreshToken || loadRefreshToken();
  if (!rt) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });

    if (!res.ok) {
      clearTokens();
      return false;
    }

    const data = await res.json();
    if (data.data?.tokens?.accessToken && data.data?.tokens?.refreshToken) {
      setTokens(data.data.tokens.accessToken, data.data.tokens.refreshToken);
      return true;
    }

    clearTokens();
    return false;
  } catch {
    clearTokens();
    return false;
  }
}

// Deduplicated refresh — multiple 401s won't fire multiple refreshes
function refreshTokenOnce(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = attemptRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// ── Core fetch wrapper ──
async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const url = `${API_BASE}${path}`;

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  // Don't set Content-Type for FormData (browser sets multipart boundary)
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const res = await fetch(url, { ...options, headers });

  // 401 → try refresh → retry once
  // But NOT for auth endpoints — a 401 on /auth/login means invalid credentials,
  // not an expired session. Let those errors pass through to show the real message.
  const isAuthEndpoint = path.startsWith('/auth/login') || path.startsWith('/auth/register') || path.startsWith('/auth/google');
  if (res.status === 401 && retry && !isAuthEndpoint) {
    const refreshed = await refreshTokenOnce();
    if (refreshed) {
      return apiFetch<T>(path, options, false);
    }
    clearTokens();
    throw new ApiError('Session expired. Please log in again.', 401, 'AUTH_EXPIRED');
  }

  // Parse response
  let body: ApiResponse<T>;
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    body = await res.json();
  } else if (contentType.includes('application/octet-stream') || contentType.includes('application/pdf')) {
    // Binary download — return blob as T
    const blob = await res.blob();
    return blob as unknown as T;
  } else {
    const text = await res.text();
    body = { success: res.ok, data: text as unknown as T };
  }

  if (!res.ok) {
    let errorMessage = body.error || body.message || `Request failed with status ${res.status}`;
    // Append Zod validation errors if present
    const rawBody = body as any;
    if (rawBody.errors && Array.isArray(rawBody.errors)) {
      const details = rawBody.errors.map((e: any) => `${e.field.replace('body.', '')}: ${e.message}`).join(', ');
      errorMessage = `${errorMessage} (${details})`;
    }

    throw new ApiError(
      errorMessage,
      res.status,
      (body as unknown as Record<string, unknown>).code as string | undefined
    );
  }

  return (body.data !== undefined ? body.data : body) as T;
}

// ── Public API methods ──

/** GET request */
export function get<T = unknown>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'GET' });
}

/** POST request with JSON body */
export function post<T = unknown>(path: string, data?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  });
}

/** PATCH request with JSON body */
export function patch<T = unknown>(path: string, data?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PATCH',
    body: data ? JSON.stringify(data) : undefined,
  });
}

/** DELETE request */
export function del<T = unknown>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' });
}

/** POST with FormData (for file uploads) */
export function upload<T = unknown>(path: string, formData: FormData): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: formData,
    // Don't set Content-Type — browser sets it with boundary
  });
}

/** Download a file as Blob */
export async function downloadBlob(path: string): Promise<Blob> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new ApiError(`Download failed: ${res.statusText}`, res.status);
  }
  return res.blob();
}

export { API_BASE };
