// Generates a VAPID key pair (P-256) for Web Push with WebCrypto only.
//   node scripts/vapid-keys.mjs [mailto:you@example.com]
// Prints the keys and ready-to-paste lines: Supabase secrets for the `sync`/`notify`/`owner`
// functions and the public key for the cabinet build. Keep the private key secret; generate once —
// a new pair invalidates every browser subscription.
const subtle = globalThis.crypto.subtle;

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
const jwk = await subtle.exportKey('jwk', pair.privateKey);
const privateKey = jwk.d;
const subject = process.argv[2] ?? 'mailto:owner@example.com';

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('');
console.log('# Supabase (terminal, project linked):');
console.log(`supabase secrets set VAPID_PUBLIC_KEY=${publicKey} VAPID_PRIVATE_KEY=${privateKey} VAPID_SUBJECT=${subject}`);
console.log('');
console.log('# Cabinet build (Cloudflare Pages / GitHub Actions variable):');
console.log(`VITE_VAPID_PUBLIC_KEY=${publicKey}`);
