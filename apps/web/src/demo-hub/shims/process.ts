/**
 * Browser stand-ins for `node:net` and `node:child_process` (demo build only):
 * the demo HUB drives simulated lamps and a simulated UPS, no sockets, no processes.
 */
function unavailable(): never {
  throw new Error('Not available in the browser demo: lamps and UPS are simulated');
}

export const createConnection = unavailable;
export const execFileSync = unavailable;
export const spawn = unavailable;

export default { createConnection, execFileSync, spawn };
