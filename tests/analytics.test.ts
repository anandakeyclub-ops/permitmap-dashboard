import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { track } from '../lib/analytics';

// Flush the detached async body of track() (awaits getToken, then fetch).
const flush = () => new Promise(r => setTimeout(r, 0));

let realFetch: typeof globalThis.fetch;

beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('track() — fire-and-forget analytics', () => {
  it('POSTs event_name + props to /analytics/event with a bearer token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({ ok: true }) as any);
    globalThis.fetch = fetchMock as any;
    const getToken = vi.fn(async () => 'tkn-123');

    track(getToken, 'saved_lead', { county: 'miami-dade', properties: { permit_number: 'BLD-1', outcome: 'saved' } });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toMatch(/\/analytics\/event$/);
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.headers.Authorization).toBe('Bearer tkn-123');
    expect(JSON.parse(init.body)).toEqual({
      event_name: 'saved_lead', county: 'miami-dade', properties: { permit_number: 'BLD-1', outcome: 'saved' },
    });
  });

  it('never throws and still posts when getToken throws (auth swallowed, no header)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({ ok: true }) as any);
    globalThis.fetch = fetchMock as any;
    const getToken = vi.fn(async () => { throw new Error('no clerk'); });

    expect(() => track(getToken, 'dashboard_viewed', { county: 'x' })).not.toThrow();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(init.headers.Authorization).toBeUndefined(); // token failure → no auth header, still sent
  });

  it('never throws when fetch rejects (network error swallowed)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => { throw new Error('network down'); });
    globalThis.fetch = fetchMock as any;
    const getToken = vi.fn(async () => 'tkn');

    expect(() => track(getToken, 'csv_export', { county: 'x' })).not.toThrow();
    await flush(); // the rejected fetch is caught inside track; no unhandled rejection
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('works when getToken is undefined (no auth header, still posts)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({ ok: true }) as any);
    globalThis.fetch = fetchMock as any;

    track(undefined, 'permit_drawer_open', { county: 'x', properties: { permit_number: 'p1' } });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, any];
    expect(init.headers.Authorization).toBeUndefined();
  });
});
