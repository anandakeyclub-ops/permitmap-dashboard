// Minimal API fetch helper for the PermitMap dashboard.
//
// Attaches a Clerk JWT (template "api") as `Authorization: Bearer <token>` when a
// token is available, so permitmap-api can authenticate the caller and apply tier
// caps once API_AUTH_MODE is no longer "off".
//
// Graceful by design: if token retrieval fails (or returns null), the request is
// sent WITHOUT an Authorization header. While API_AUTH_MODE=off, anonymous requests
// still succeed — so the dashboard keeps working even if the token can't be fetched.

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

// Loosely typed to avoid importing Clerk's internal types; matches useAuth().getToken.
type GetToken = (options?: { template?: string }) => Promise<string | null>;

export async function apiFetch(path: string, getToken?: GetToken): Promise<Response> {
  const headers: Record<string, string> = {};
  if (getToken) {
    try {
      const token = await getToken({ template: 'api' });
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } catch {
      // Token retrieval failed — proceed unauthenticated (API is OFF → anonymous OK).
    }
  }
  return fetch(`${API_BASE}${path}`, { headers });
}
