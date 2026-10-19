/**
 * Certificate facts shared by the CA tooling (ca.ts, node-only) and the TLS routes
 * (routes.ts). No Node built-ins here: routes.ts is also bundled into the in-browser demo HUB.
 */

/** `ca init` re-issues the server certificate this long before it expires. */
export const RENEW_BEFORE_DAYS = 30;

export interface CertInfo {
  caSubject: string;
  /** SHA-256 of the root, `AA:BB:…` — what the tablet shows in certificate details. */
  caFingerprint: string;
  caValidTo: number;
  serverValidTo: number;
  dnsNames: string[];
  ips: string[];
}
