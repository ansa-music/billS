/** Browser stand-in for `node:url` (demo build only). */
export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent((typeof url === 'string' ? new URL(url) : url).pathname);
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${path.startsWith('/') ? '' : '/'}${path}`);
}

export default { fileURLToPath, pathToFileURL };
