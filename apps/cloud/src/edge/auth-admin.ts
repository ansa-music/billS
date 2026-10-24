import { CloudError } from '../errors.ts';

/**
 * The part of the Supabase Auth (GoTrue) admin API the `invite-manager` function needs, over plain
 * fetch: the Edge bundle may not import supabase-js (only `node:*`). The service-role key goes
 * as `apikey` and `Authorization: Bearer`. Supabase sends the letters itself (its SMTP).
 */
export interface AuthAdmin {
  /** POST /invite: a new account + the invitation letter; 'exists' when a confirmed account has this e-mail. */
  invite(email: string, redirectTo: string, data: Record<string, unknown>): Promise<'invited' | 'exists'>;
  /** POST /recover: the password-reset letter (what resetPasswordForEmail does). */
  recover(email: string, redirectTo: string): Promise<void>;
  /** POST /admin/users with email_confirm: true → the new user's id; 409 EMAIL_TAKEN when the e-mail has an account. */
  createUser(email: string, password: string, userMetadata: Record<string, unknown>): Promise<string>;
  /** DELETE /admin/users/:id (a sign-up that failed half-way); a user already gone is not an error. */
  deleteUser(id: string): Promise<void>;
  /** PUT /admin/users/:id: a new password, the e-mail confirmed. */
  updateUser(id: string, password: string, userMetadata: Record<string, unknown>): Promise<void>;
}

interface GoTrueError {
  status: number;
  code: string;
  message: string;
}

async function goTrueError(res: Response): Promise<GoTrueError> {
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    status: res.status,
    code: str(data.error_code) || str(data.code) || str(data.error),
    message: str(data.msg) || str(data.message) || str(data.error_description) || `HTTP ${res.status}`,
  };
}

const EXISTS = /already (been )?registered|already exists/i;

const isExists = (e: GoTrueError): boolean =>
  e.code === 'email_exists' || e.code === 'user_already_exists' || (e.status === 422 && EXISTS.test(e.message));

export const EMAIL_TAKEN_MESSAGE = 'Эта почта уже зарегистрирована — войдите';

/** GoTrue's answer → what the platform owner should read. */
export function authAdminError(e: GoTrueError): CloudError {
  if (e.status === 429 || /rate_limit/.test(e.code)) {
    return new CloudError(429, 'RATE_LIMIT', 'Письмо на этот адрес уже отправляли только что. Подождите минуту или выдайте временный пароль');
  }
  if (e.code === 'weak_password') return new CloudError(422, 'WEAK_PASSWORD', `Supabase не принял пароль: ${e.message}`);
  if (e.code === 'email_address_invalid' || e.code === 'validation_failed') {
    return new CloudError(422, 'EMAIL_INVALID', `Supabase не принял адрес: ${e.message}`);
  }
  if (/sending|smtp|email/i.test(e.message) && e.status >= 500) {
    return new CloudError(
      502,
      'EMAIL_FAILED',
      'Supabase не смог отправить письмо (встроенная почта Supabase шлёт только на адреса команды проекта — нужен свой SMTP). Выдайте временный пароль',
    );
  }
  return new CloudError(502, 'AUTH_ADMIN', `Supabase Auth: ${e.message}`);
}

export function authAdminApi(supabaseUrl: string, serviceKey: string, fetchFn: typeof fetch = fetch): AuthAdmin {
  const base = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };
  const call = async (method: string, path: string, body: unknown): Promise<Response> => {
    try {
      return await fetchFn(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new CloudError(502, 'AUTH_ADMIN', `Нет связи с Supabase Auth: ${(e as Error).message}`);
    }
  };
  const redirect = (url: string) => `?redirect_to=${encodeURIComponent(url)}`;
  return {
    async invite(email, redirectTo, data) {
      const res = await call('POST', `/invite${redirect(redirectTo)}`, { email, data });
      if (res.ok) return 'invited';
      const e = await goTrueError(res);
      if (isExists(e)) return 'exists';
      throw authAdminError(e);
    },
    async recover(email, redirectTo) {
      const res = await call('POST', `/recover${redirect(redirectTo)}`, { email });
      if (!res.ok) throw authAdminError(await goTrueError(res));
    },
    async createUser(email, password, userMetadata) {
      const res = await call('POST', '/admin/users', { email, password, email_confirm: true, user_metadata: userMetadata });
      if (!res.ok) {
        const e = await goTrueError(res);
        if (isExists(e)) throw new CloudError(409, 'EMAIL_TAKEN', EMAIL_TAKEN_MESSAGE);
        throw authAdminError(e);
      }
      const user = (await res.json()) as { id?: unknown };
      if (typeof user.id !== 'string') throw new CloudError(502, 'AUTH_ADMIN', 'Supabase Auth не вернул пользователя');
      return user.id;
    },
    async updateUser(id, password, userMetadata) {
      const res = await call('PUT', `/admin/users/${encodeURIComponent(id)}`, { password, email_confirm: true, user_metadata: userMetadata });
      if (!res.ok) throw authAdminError(await goTrueError(res));
    },
    async deleteUser(id) {
      const res = await call('DELETE', `/admin/users/${encodeURIComponent(id)}`, { should_soft_delete: false });
      if (!res.ok && res.status !== 404) throw authAdminError(await goTrueError(res));
    },
  };
}
