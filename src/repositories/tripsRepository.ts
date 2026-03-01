import { query } from '../db';

export async function getCurrentHKHour(): Promise<number> {
  const result = await query(
    "SELECT EXTRACT(hour FROM now() AT TIME ZONE 'Asia/Hong_Kong')::int AS h"
  );
  return Number(result.rows[0]?.h ?? 0);
}

export interface DbTrip {
  id: string;
  vehicle_id: string;
  actual_start_at: string;
  actual_arrival_at: string | null;
  status: string;
  corrected?: boolean;
  concrete_plant?: string;
}

export async function getTodayInProgressTrips(): Promise<DbTrip[]> {
  const sql = `
    SELECT id, vehicle_id, actual_start_at, actual_arrival_at, status, corrected
    FROM public.trips
    WHERE (actual_start_at AT TIME ZONE 'Asia/Hong_Kong')::date =
          (now() AT TIME ZONE 'Asia/Hong_Kong')::date
    ORDER BY actual_start_at ASC
  `;
  const result = await query(sql);
  const rows = result.rows as DbTrip[];
  return rows.filter((t) => t.status === 'in_progress');
}

export async function getTodayTrips(
  date?: string | null,
  hourFrom?: string | number | null,
  hourTo?: string | number | null
): Promise<DbTrip[]> {
  const sql = `
    WITH params AS (
      SELECT
        COALESCE($1::date, (now() AT TIME ZONE 'Asia/Hong_Kong')::date) AS hk_date,
        $2::int AS hour_from,
        $3::int AS hour_to
    )
    SELECT t.*
    FROM public.trips t
    CROSS JOIN params
    WHERE (t.actual_start_at AT TIME ZONE 'Asia/Hong_Kong')::date = params.hk_date
      AND (params.hour_from IS NULL
           OR EXTRACT(hour FROM (t.actual_start_at AT TIME ZONE 'Asia/Hong_Kong')) >= params.hour_from)
      AND (params.hour_to IS NULL
           OR EXTRACT(hour FROM (t.actual_start_at AT TIME ZONE 'Asia/Hong_Kong')) < params.hour_to)
    ORDER BY t.actual_start_at ASC
    LIMIT 200
  `;
  const result = await query(sql, [
    date ?? null,
    hourFrom ?? null,
    hourTo ?? null,
  ]);
  return result.rows as DbTrip[];
}

export interface TripWithArrivalHour extends DbTrip {
  arrival_hour: number;
}

export async function getTodayCompletedTripsWithArrivalHour(
  displayStartHour: number,
  displayEndHour: number
): Promise<TripWithArrivalHour[]> {
  const sql = `
    SELECT
      id,
      vehicle_id,
      actual_start_at,
      actual_arrival_at,
      status,
      EXTRACT(hour FROM (actual_arrival_at AT TIME ZONE 'Asia/Hong_Kong'))::int AS arrival_hour
    FROM public.trips
    WHERE (actual_start_at AT TIME ZONE 'Asia/Hong_Kong')::date =
          (now() AT TIME ZONE 'Asia/Hong_Kong')::date
      AND status = 'completed'
      AND actual_arrival_at IS NOT NULL
      AND EXTRACT(hour FROM (actual_arrival_at AT TIME ZONE 'Asia/Hong_Kong')) >= $1
      AND EXTRACT(hour FROM (actual_arrival_at AT TIME ZONE 'Asia/Hong_Kong')) < $2
  `;
  const result = await query(sql, [displayStartHour, displayEndHour]);
  return result.rows as TripWithArrivalHour[];
}

export async function insertTrip(
  vehicleId: string,
  actualStartAt: Date,
  concretePlant: string,
  corrected?: boolean
): Promise<DbTrip> {
  const sql = `
    INSERT INTO public.trips (vehicle_id, actual_start_at, concrete_plant, status, corrected)
    VALUES ($1, $2, $3, 'in_progress', COALESCE($4, false))
    RETURNING *
  `;
  const result = await query(sql, [
    vehicleId,
    actualStartAt.toISOString(),
    concretePlant,
    corrected,
  ]);
  return result.rows[0] as DbTrip;
}

export async function completeTrip(
  tripId: string,
  actualArrivalAt: Date,
  corrected?: boolean
): Promise<DbTrip | null> {
  const sql = `
    UPDATE public.trips
    SET actual_arrival_at = $1, status = 'completed',
        corrected = COALESCE($2, corrected), updated_at = now()
    WHERE id = $3
    RETURNING *
  `;
  const result = await query(sql, [
    actualArrivalAt.toISOString(),
    corrected,
    tripId,
  ]);
  return (result.rows[0] as DbTrip) ?? null;
}
