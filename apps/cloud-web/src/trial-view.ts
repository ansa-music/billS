/**
 * «Смотреть с телефона»: the coffee-shop owner's read-only page, #/v/<token>. No account and no
 * supabase-js: the token in the address (never sent to a server — it is the hash part) goes to the
 * public `trial` function as a Bearer, which answers only that coffee shop's latest summary.
 *
 *   GET {SUPABASE_URL}/functions/v1/trial/trial/view  (Authorization: Bearer <view token>) → TrialPublicView
 *
 * Pure words are tested in test/trial-view.test.ts.
 */
import type { TrialPublicView, TrialSummary } from '@bills/domain';
import { SUPABASE_MODE, supabaseAnonKey, supabaseUrl } from './config.ts';
import { viewErrorText } from './trial-view-words.ts';

export * from './trial-view-words.ts';

export type { TrialPublicView, TrialSummary };

export class ViewError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function fetchTrialView(token: string): Promise<TrialPublicView> {
  if (!SUPABASE_MODE) throw new ViewError(404, 'NOT_AVAILABLE', viewErrorText('NOT_AVAILABLE', 404));
  let res: Response;
  try {
    res = await fetch(`${supabaseUrl()}/functions/v1/trial/trial/view`, {
      headers: { apikey: supabaseAnonKey(), authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    throw new ViewError(0, 'OFFLINE', viewErrorText('OFFLINE', 0));
  }
  if (!res.ok) {
    let code = 'HTTP_ERROR';
    try {
      code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code;
    } catch {
      // not JSON
    }
    throw new ViewError(res.status, code, viewErrorText(code, res.status));
  }
  return (await res.json()) as TrialPublicView;
}

