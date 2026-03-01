import { query } from '../db';

export interface DeliveryTargetRow {
  operation_date: string;
  target_concrete_volume: number;
  work_start_hour: string;
  work_end_hour: string;
  planned_trucks_per_hour: number;
  h07_08?: number;
  h08_09?: number;
  h09_10?: number;
  h10_11?: number;
  h11_12?: number;
  h12_13?: number;
  h13_14?: number;
  h14_15?: number;
  h15_16?: number;
  h16_17?: number;
  h17_18?: number;
  h18_19?: number;
  h19_20?: number;
  h20_21?: number;
  h21_22?: number;
  h22_23?: number;
  h23_00?: number;
}

export interface TodayDeliveryTarget {
  targetVolume: number;
  trucksPerHour: number;
  startTime: string;
  endTime: string;
}

export async function getTodayDeliveryTarget(): Promise<TodayDeliveryTarget | null> {
  const sql = `
    SELECT operation_date, target_concrete_volume, work_start_hour, work_end_hour,
           planned_trucks_per_hour
    FROM public.delivery_targets
    WHERE operation_date = (now() AT TIME ZONE 'Asia/Hong_Kong')::date
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `;
  const result = await query(sql);
  const row = result.rows[0] as DeliveryTargetRow | undefined;
  if (!row) return null;

  return {
    targetVolume: Number(row.target_concrete_volume) || 600,
    trucksPerHour: Number(row.planned_trucks_per_hour) || 12,
    startTime: row.work_start_hour,
    endTime: row.work_end_hour,
  };
}

export interface TruckPlan {
  operationDate: string;
  trucksPerHour: number;
  workingHours: number;
  workStart: string;
  workEnd: string;
  targetVolume: number;
  hourlyPlan: Record<number, number>;
  plannedTripsTotal: number;
}

const HOURLY_COLUMNS = [
  'h07_08', 'h08_09', 'h09_10', 'h10_11', 'h11_12', 'h12_13', 'h13_14', 'h14_15',
  'h15_16', 'h16_17', 'h17_18', 'h18_19', 'h19_20', 'h20_21', 'h21_22', 'h22_23', 'h23_00',
] as const;

export async function getTodayTruckPlan(): Promise<TruckPlan | null> {
  const sql = `
    SELECT operation_date, target_concrete_volume, work_start_hour, work_end_hour,
           planned_trucks_per_hour,
           h07_08, h08_09, h09_10, h10_11, h11_12, h12_13, h13_14, h14_15,
           h15_16, h16_17, h17_18, h18_19, h19_20, h20_21, h21_22, h22_23, h23_00
    FROM public.delivery_targets
    WHERE operation_date = (now() AT TIME ZONE 'Asia/Hong_Kong')::date
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `;
  const result = await query(sql);
  const row = result.rows[0] as DeliveryTargetRow | undefined;
  if (!row) return null;

  const workStart = row.work_start_hour;
  const workEnd = row.work_end_hour;
  const [shRaw, smRaw] = workStart.split(':');
  const [ehRaw, emRaw] = workEnd.split(':');
  const startMinutes = Number(shRaw ?? 0) * 60 + Number(smRaw ?? 0);
  const endMinutes = Number(ehRaw ?? 0) * 60 + Number(emRaw ?? 0);
  const workingMinutes = Math.max(0, endMinutes - startMinutes);
  const workingHours = workingMinutes / 60;

  const hourlyPlan: Record<number, number> = {};
  HOURLY_COLUMNS.forEach((col, i) => {
    const val = (row as unknown as Record<string, unknown>)[col];
    hourlyPlan[7 + i] = Number(val ?? 0);
  });

  const plannedTripsTotal = Object.values(hourlyPlan).reduce((s, v) => s + v, 0);

  return {
    operationDate: row.operation_date,
    trucksPerHour: Number(row.planned_trucks_per_hour) || 0,
    workingHours,
    workStart,
    workEnd,
    targetVolume: Number(row.target_concrete_volume) || 0,
    hourlyPlan,
    plannedTripsTotal,
  };
}

export interface DeliveryTargetForApi extends DeliveryTargetRow {
  work_start_time?: string;
  work_end_time?: string;
}

export async function getDeliveryTargets(date?: string | null): Promise<DeliveryTargetForApi[]> {
  const sql = `
    WITH params AS (SELECT $1::date AS hk_date)
    SELECT operation_date, target_concrete_volume, work_start_hour, work_end_hour,
           planned_trucks_per_hour
    FROM public.delivery_targets
    CROSS JOIN params
    WHERE params.hk_date IS NULL OR operation_date = params.hk_date
    ORDER BY operation_date ASC
    LIMIT 365
  `;
  const result = await query(sql, [date ?? null]);
  const rows = result.rows as DeliveryTargetRow[];
  return rows.map((r) => ({
    ...r,
    work_start_time: r.work_start_hour,
    work_end_time: r.work_end_hour,
  }));
}
