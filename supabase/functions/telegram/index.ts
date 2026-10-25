// Edge Function `telegram` — webhook of the TS bot; thin Deno wrapper, the logic lives in apps/cloud/src (bundled into _shared/core.js).
// @ts-types="../_shared/core.d.ts"
import { handleTelegram } from '../_shared/core.js';
import { serve } from '../_shared/context.ts';

serve(handleTelegram);
