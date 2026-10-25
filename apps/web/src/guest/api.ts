import type {
  CreateCounterOrderRequest,
  CreateCounterOrderResponse,
  CreateGuestRequest,
  GuestLinksResponse,
  GuestLinkView,
  GuestPageView,
  GuestRequestsResponse,
  GuestRequestView,
  OrderView,
  StaffGuestRequestView,
} from '@bills/domain';
import { command, fetchJson, HubRequestError, hubUrl, newKey } from '../api.ts';

/**
 * HUB calls of «Страница гостя по QR». The guest's calls are public: no session token
 * is sent, the token of the sticker in the path is the key. Staff calls go through the
 * usual fetchJson / command with the signed-in employee.
 */

async function guestCall<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(hubUrl(path), { cache: 'no-store', ...init });
  } catch {
    throw new HubRequestError(0, 'OFFLINE', 'Нет связи с Wi-Fi заведения');
  }
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    let message = `Ошибка ${res.status}`;
    let retry: number | null = null;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; retryAfterMs?: number } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      retry = typeof body.error?.retryAfterMs === 'number' ? body.error.retryAfterMs : null;
    } catch {
      // Not JSON: keep the plain status.
    }
    throw new HubRequestError(res.status, code, message, retry);
  }
  return (await res.json()) as T;
}

export const fetchGuestPage = (token: string, mine: readonly string[]) =>
  guestCall<GuestPageView>(`/api/guest/${encodeURIComponent(token)}${mine.length ? `?mine=${mine.join(',')}` : ''}`);

export const sendGuestRequest = (token: string, body: CreateGuestRequest) =>
  guestCall<GuestRequestView>(`/api/guest/${encodeURIComponent(token)}/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientKey: newKey().replace(/[^A-Za-z0-9]/g, ''), ...body }),
  });

// ── Staff ────────────────────────────────────────────────────────────────────

export const fetchGuestRequests = () => fetchJson<GuestRequestsResponse>('/api/guest-requests');

export const acceptGuestRequest = (actor: string, id: string) =>
  command<{ request: StaffGuestRequestView; order: OrderView | null }>(`/api/guest-requests/${id}/accept`, actor, {});

export const rejectGuestRequest = (actor: string, id: string, reason?: string) =>
  command<StaffGuestRequestView>(`/api/guest-requests/${id}/reject`, actor, reason ? { reason } : {});

/** «Касса»: the order ahead with its payment, the same body as POST /api/counter/orders. */
export const takeGuestCounterOrder = (actor: string, id: string, body: CreateCounterOrderRequest, key: string) =>
  command<CreateCounterOrderResponse & { request: StaffGuestRequestView }>(`/api/guest-requests/${id}/counter-order`, actor, body, 'POST', key);

export const fetchGuestLinks = () => fetchJson<GuestLinksResponse>('/api/guest-links');

export const setGuestEnabled = (actor: string, enabled: boolean) =>
  command<GuestLinksResponse>('/api/guest-links/settings', actor, { enabled });

export const rotateGuestLink = (actor: string, id: string) => command<GuestLinkView>(`/api/guest-links/${id}/rotate`, actor, {});

/** The address a sticker opens: this HUB's page, `#/g/<token>`. */
export function guestUrl(token: string, origin = window.location.origin + window.location.pathname): string {
  return `${origin.replace(/\/+$/, '')}/#/g/${token}`;
}
