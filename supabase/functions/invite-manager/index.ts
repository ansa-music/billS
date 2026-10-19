// Edge Function `invite-manager` — thin Deno wrapper; the logic lives in apps/cloud/src/edge (bundled into _shared/core.js).
// @ts-types="../_shared/core.d.ts"
import { handleInviteManager } from '../_shared/core.js';
import { serve } from '../_shared/context.ts';

serve(handleInviteManager);
