import { createPublicBooking, publicAvailability } from '../booking.ts';
import { CloudError } from '../errors.ts';
import type { EdgeContext } from './context.ts';
import { flushQuietly } from './context.ts';
import type { EdgeRequest } from './http.ts';
import { errorResponse, json, notFound, readJson, routeOf } from './http.ts';
import { corsHeaders } from './owner.ts';
import { clientIp } from './signup.ts';

/**
 * Edge Function `booking` (verify_jwt = false): «Онлайн-бронь столов», the guest's side.
 * Anyone on the internet; guarded inside — the club must have online booking switched on,
 * attempts are limited per IP and per phone (booking_attempts), capacity is checked in a
 * transaction with the club row locked.
 *
 *   GET  /booking/<slug|clubId>/availability?date=YYYY-MM-DD → BookingAvailability
 *        (404 BOOKING_NOT_FOUND when off or unknown, 422 DAY_OUT_OF_RANGE)
 *   POST /booking/<slug|clubId>  CreateBookingRequest → 201 CreateBookingResponse
 *        (422 NAME_REQUIRED / PHONE_INVALID / SLOT_INVALID / SLOT_TOO_SOON / DURATION_INVALID / KIND_INVALID,
 *         409 SLOT_TAKEN / TOO_MANY_BOOKINGS, 429 RATE_LIMITED)
 */
export async function handleBooking(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  const cors = corsHeaders(req, ctx);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const { path, query } = routeOf(req.url);
    const clean = path.replace(/^\/booking(?=\/booking(\/|$))/, '');
    const m = /^\/booking\/([^/]+)(\/availability)?$/.exec(clean);
    if (!m) return notFound(cors);
    let ref: string;
    try {
      ref = decodeURIComponent(m[1]!);
    } catch {
      throw new CloudError(404, 'BOOKING_NOT_FOUND', 'Онлайн-бронь в этом заведении не работает');
    }
    const headers = { ...cors, 'cache-control': 'no-store' };
    if (req.method === 'GET' && m[2]) {
      return json(200, await publicAvailability(ctx.db, ctx.now(), ref, query.get('date')), headers);
    }
    if (req.method === 'POST' && !m[2]) {
      const res = await createPublicBooking(ctx.db, ctx.now(), ref, await readJson(req), clientIp(req));
      ctx.log(`booking: новая бронь ${res.id}`);
      await flushQuietly(ctx);
      return json(201, res, headers);
    }
    return notFound(cors);
  } catch (e) {
    return errorResponse(e, ctx.log, cors);
  }
}
