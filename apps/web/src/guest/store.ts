import { useEffect, useSyncExternalStore } from 'react';
import type { GuestRequestsResponse } from '@bills/domain';
import { fetchGuestRequests } from './api.ts';

/**
 * Guest requests for the staff screens: one request to the HUB per change event, shared
 * by the hall list, the badges on the table cards and the counter — however many of them
 * are on screen.
 */

let data: GuestRequestsResponse | null = null;
let loadedFor = -1;
let inFlight = false;
let again = false;
const listeners = new Set<() => void>();

function fetchNow(): void {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  void fetchGuestRequests()
    .then((d) => {
      data = d;
      for (const l of listeners) l();
    })
    .catch(() => {
      // No access (a role without the hall) or offline: keep what we had.
    })
    .finally(() => {
      inFlight = false;
      if (again) {
        again = false;
        fetchNow();
      }
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Refetches when `version` (useHub().version: every change event) moves on. */
export function useGuestRequests(version: number): GuestRequestsResponse | null {
  useEffect(() => {
    if (version === loadedFor) return;
    loadedFor = version;
    fetchNow();
  }, [version]);
  return useSyncExternalStore(subscribe, () => data);
}

/** After an accept or reject: read again right away. */
export const reloadGuestRequests = fetchNow;
