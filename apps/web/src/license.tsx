import type { Action, LicenseState, LicenseStatus, RoleSet } from '@bills/domain';
import { ACTION_MODULE, MODULE_LABEL, decide, licenseGateOf } from '@bills/domain';

/**
 * The license of this branch as screens see it: the banner in the shell and
 * the reason a button is switched off. The HUB enforces the same rules
 * (`decide` in packages/domain); the screen only hides what would be refused.
 */

export const LICENSE_STATE_LABEL: Record<LicenseState, string> = {
  active: 'Действует',
  expiring: 'Скоро закончится',
  last_day: 'Последний день',
  expired: 'Срок истёк',
  blocked: 'Приостановлена',
  not_yet: 'Ещё не началась',
  wrong_hub: 'Для другого филиала',
  missing: 'Не установлена',
  invalid: 'Не прошла проверку',
};

/** Tag class for a state: green / yellow / red. */
export function licenseTone(state: LicenseState): 'ok' | 'warn' | 'danger' {
  if (state === 'active') return 'ok';
  if (state === 'expiring' || state === 'last_day') return 'warn';
  return 'danger';
}

const READ_ONLY_TEXT = 'Лицензия не активна — режим «только чтение».';

/**
 * Why `action` is not available right now, or null when it is. Role first,
 * then the license (read-only mode, a module that is not bought).
 */
export function blockedReason(roles: RoleSet, action: Action, license: LicenseStatus | null): string | null {
  switch (decide(roles, action, licenseGateOf(license))) {
    case 'ok':
      return null;
    case 'forbidden':
      return 'Недостаточно прав для этого действия.';
    case 'read_only':
      return `Только чтение: ${license?.message ?? READ_ONLY_TEXT}`;
    case 'module_off': {
      const mod = ACTION_MODULE[action];
      return mod ? `Модуль «${MODULE_LABEL[mod]}» не входит в лицензию клуба.` : 'Модуль не входит в лицензию клуба.';
    }
  }
}

/**
 * Strip under the top bar: yellow a few days before the end, red in read-only
 * mode. Nothing while the license is fine or not enforced (null).
 */
export function LicenseBanner({ license }: { license: LicenseStatus | null | undefined }) {
  if (!license) return null;
  const tone = licenseTone(license.state);
  if (tone === 'ok' && !license.readOnly) return null;
  const danger = license.readOnly || tone === 'danger';
  return (
    <div className="license-banner" data-tone={danger ? 'danger' : 'warn'} role={danger ? 'alert' : 'status'}>
      <p className="license-banner-text">
        <strong>{danger ? 'Только чтение.' : 'Лицензия.'}</strong>{' '}
        {license.message ?? (danger ? READ_ONLY_TEXT : 'Лицензия скоро закончится. Продлите доступ.')}
      </p>
    </div>
  );
}
