// Edge Function `booking` — thin Deno wrapper; the logic lives in apps/cloud/src/edge (bundled into _shared/core.js).
// @ts-types="../_shared/core.d.ts"
import { handleBooking } from '../_shared/core.js';
import { serve } from '../_shared/context.ts';

serve(handleBooking);
