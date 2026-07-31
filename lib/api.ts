// Minimal API fetch helper for the PermitMap dashboard.
//
// Attaches a Clerk JWT (template "api") as `Authorization: Bearer <token>` when a
// token is available, so permitmap-api can authenticate the caller and apply tier
// caps once API_AUTH_MODE is no longer "off".
//
// Graceful by design: if token retrieval fails (or returns null), the request is
// sent WITHOUT an Authorization header. While API_AUTH_MODE=off, anonymous requests
// still succeed — so the dashboard keeps working even if the token can't be fetched.

import type {
  SavedLead, SavedLeadStatus, SavedLeadCounts, PermitRow,
} from './types';
import { buildSaveLeadPayload } from './saveLeadState';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

// Loosely typed to avoid importing Clerk's internal types; matches useAuth().getToken.
export type GetToken = (options?: { template?: string }) => Promise<string | null>;

// Optional method/body for write requests. Omitted entirely by existing GET callers,
// so their behavior is unchanged. A JSON body sets Content-Type automatically.
type ApiInit = { method?: string; body?: unknown; headers?: Record<string, string> };

export async function apiFetch(
  path: string,
  getToken?: GetToken,
  init?: ApiInit,
): Promise<Response> {
  const headers: Record<string, string> = { ...(init?.headers || {}) };
  if (getToken) {
    try {
      const token = await getToken({ template: 'api' });
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } catch {
      // Token retrieval failed — proceed unauthenticated (API is OFF → anonymous OK).
    }
  }
  const opts: RequestInit = { method: init?.method, headers };
  if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(init.body);
  }
  return fetch(`${API_BASE}${path}`, opts);
}

// ── Saved Leads (Phase C) ─────────────────────────────────────────────────────
// These hit the auth-gated /saved-leads endpoints, so getToken is required (a CRM
// row has no owner without it). It's threaded explicitly to match the existing
// apiFetch pattern — components pass useAuth().getToken in.

// GET /saved-leads — caller's leads (saved_at desc) + full-pipeline counts.
export async function getSavedLeads(
  getToken: GetToken,
  status?: SavedLeadStatus,
  county?: string,
): Promise<{ leads: SavedLead[]; counts: SavedLeadCounts }> {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (county) qs.set('county', county);
  const q = qs.toString();
  const res = await apiFetch(`/saved-leads${q ? `?${q}` : ''}`, getToken);
  if (!res.ok) throw new Error(`getSavedLeads failed: ${res.status}`);
  return res.json();
}

// POST /saved-leads — maps a permit row to the API body. Resolves (never throws)
// on 409: returns { already_saved: true } so optimistic UI can settle gracefully.
export async function saveLead(
  getToken: GetToken,
  permit: PermitRow,
): Promise<{ lead: SavedLead | null; already_saved: boolean }> {
  const body = buildSaveLeadPayload(permit); // shared builder — identical payload to before
  const res = await apiFetch('/saved-leads', getToken, { method: 'POST', body });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({} as any));
    return { lead: data.lead ?? null, already_saved: true };
  }
  if (!res.ok) throw new Error(`saveLead failed: ${res.status}`);
  return res.json();   // { lead, already_saved: false }
}

// GET /saved-leads/check/:permit_id — fast save-state probe for permit rows.
export async function checkSavedLead(
  getToken: GetToken,
  permit_id: string,
): Promise<{ saved: boolean; lead_id?: string; status?: SavedLeadStatus }> {
  const res = await apiFetch(`/saved-leads/check/${encodeURIComponent(permit_id)}`, getToken);
  if (!res.ok) return { saved: false };
  return res.json();
}

// PATCH /saved-leads/:id — update status and/or notes.
export async function updateSavedLead(
  getToken: GetToken,
  id: string,
  status?: SavedLeadStatus,
  notes?: string,
): Promise<{ lead: SavedLead }> {
  const body: { status?: SavedLeadStatus; notes?: string } = {};
  if (status !== undefined) body.status = status;
  if (notes !== undefined) body.notes = notes;
  const res = await apiFetch(`/saved-leads/${encodeURIComponent(id)}`, getToken, {
    method: 'PATCH', body,
  });
  if (!res.ok) throw new Error(`updateSavedLead failed: ${res.status}`);
  return res.json();
}

// DELETE /saved-leads/:id — remove a saved lead.
export async function deleteSavedLead(
  getToken: GetToken,
  id: string,
): Promise<{ deleted: boolean }> {
  const res = await apiFetch(`/saved-leads/${encodeURIComponent(id)}`, getToken, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`deleteSavedLead failed: ${res.status}`);
  return res.json();
}
