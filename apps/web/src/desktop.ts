/**
 * Running inside the TS desktop app (apps/desktop, Tauri): it injects window.__TAURI__ into the
 * HUB pages and allows them a couple of commands (apps/desktop/src-tauri/capabilities/hub.json).
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function desktopInvoke(): Invoke | null {
  const tauri = (window as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function' ? tauri.core.invoke : null;
}

export function isDesktopApp(): boolean {
  return desktopInvoke() !== null;
}

/**
 * Prints the current page's print view on the device's receipt printer without a dialog.
 * Resolves false when not in the desktop app; rejects when the app could not print.
 */
export async function printSilently(widthMm: number, heightMm: number): Promise<boolean> {
  const invoke = desktopInvoke();
  if (!invoke) return false;
  await invoke('print_receipt', { page: { widthMm, heightMm } });
  return true;
}
