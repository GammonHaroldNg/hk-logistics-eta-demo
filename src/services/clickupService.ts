// src/services/clickupService.ts — Fetch lists/tasks from ClickUp and map to simulation trips
// Uses global fetch (Node 18+)
import {
  CU_FIELD_TRUCK_LICENSE,
  CU_FIELD_CONCRETE_PLANT,
  CU_FIELD_ACTUAL_DEPARTURE,
  CU_FIELD_ACTUAL_ARRIVAL,
  CU_FIELD_M3_PER_TRUCK,
  CU_FIELD_TIME_PERIOD,
  CU_OPT_GAMMON_TM,
  CU_OPT_HKC_TY,
  CU_SPACE_ID,
  CU_DEFAULT_LIST_ID,
  CU_STATUS_ENDED,
  CU_TIME_PERIOD_OPTIONS,
} from '../constants/clickupConfig';
import type { PathId } from '../constants/projectRoutes';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

function getToken(): string {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error('CLICKUP_API_TOKEN is not set');
  return token;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: getToken(),
    'Content-Type': 'application/json',
  };
}

/** Resolve custom field value by id from task.custom_fields */
function getCustomField(task: any, fieldId: string): any {
  const arr = task.custom_fields || [];
  const f = arr.find((x: any) => x.id === fieldId);
  return f?.value;
}

/**
 * Parse ClickUp date value to ISO string. Handles:
 * - number (ms timestamp)
 * - string that is numeric (ms)
 * - object with .timestamp or .value (ms)
 * - ISO string, US display "3/2/26, 6:52am", "M/D/YY HH:MM", time only "06:00:00"
 */
function parseDateValue(v: any): string | null {
  if (v == null) return null;
  try {
    let d: Date;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v <= 0) return null;
      d = new Date(v);
    } else if (typeof v === 'string') {
      const s = String(v).trim();
      if (!s) return null;
      const asNum = /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
      if (Number.isFinite(asNum) && asNum > 0) {
        d = new Date(asNum);
      } else {
        const parsed = parseDateString(s);
        if (!parsed) return null;
        d = parsed;
      }
    } else if (typeof v === 'object' && v !== null) {
      const raw = (v as any).timestamp ?? (v as any).value ?? (v as any).date;
      const parsed = parseDateValue(raw);
      return parsed;
    } else {
      return null;
    }
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function parseDateString(s: string): Date | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  if (Number.isFinite(d.getTime())) return d;
  const today = new Date();
  const tzYear = today.getFullYear();
  const tzMonth = today.getMonth();
  const tzDate = today.getDate();
  const patterns: Array<{ regex: RegExp; build: (m: string[]) => Date }> = [
    { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})\s*(am|pm)$/i, build: (p) => {
      const y = (p[2]!.length === 2) ? 2000 + parseInt(p[2]!, 10) : parseInt(p[2]!, 10);
      let h = parseInt(p[3]!, 10);
      if ((p[5] ?? '').toLowerCase() === 'pm' && h < 12) h += 12;
      if ((p[5] ?? '').toLowerCase() === 'am' && h === 12) h = 0;
      return new Date(y, parseInt(p[0]!, 10) - 1, parseInt(p[1]!, 10), h, parseInt(p[4]!, 10), 0, 0);
    }},
    { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/, build: (p) => {
      const y = (p[2]!.length === 2) ? 2000 + parseInt(p[2]!, 10) : parseInt(p[2]!, 10);
      return new Date(y, parseInt(p[0]!, 10) - 1, parseInt(p[1]!, 10), parseInt(p[3]!, 10), parseInt(p[4]!, 10), 0, 0);
    }},
    { regex: /^(\d{1,2}):(\d{2}):(\d{2})$/, build: (p) =>
      new Date(tzYear, tzMonth, tzDate, parseInt(p[0]!, 10), parseInt(p[1]!, 10), parseInt(p[2]!, 10), 0)
    },
    { regex: /^(\d{1,2}):(\d{2})\s*(am|pm)$/i, build: (p) => {
      let h = parseInt(p[0]!, 10);
      if ((p[2] ?? '').toLowerCase() === 'pm' && h < 12) h += 12;
      if ((p[2] ?? '').toLowerCase() === 'am' && h === 12) h = 0;
      return new Date(tzYear, tzMonth, tzDate, h, parseInt(p[1]!, 10), 0, 0);
    }},
  ];
  for (const { regex, build } of patterns) {
    const m = trimmed.match(regex);
    if (m) {
      const parts: string[] = m.slice(1).map((x) => x ?? '');
      if (parts.some((p) => p === '')) continue;
      try {
        const out = build(parts);
        if (Number.isFinite(out.getTime())) return out;
      } catch { /* skip */ }
    }
  }
  return null;
}

/** Map Concrete Plant option ID to pathId */
function plantOptionToPathId(optionId: any): PathId {
  if (optionId === CU_OPT_HKC_TY) return 'HKC_TY';
  return 'GAMMON_TM'; // default or Gammon
}

/** Trip shape compatible with truckService (DbTrip + pathId for simulation) */
export interface ClickUpTrip {
  id: string;
  vehicle_id: string;
  actual_start_at: string | null;
  actual_arrival_at: string | null;
  /** When actual_start_at is missing, use this for simulation start (e.g. from Time Period 06:00-07:00 → 06:00). */
  planned_start_at: string | null;
  /** Time period label for planned count (e.g. "06:00-07:00"). */
  time_period: string | null;
  status: 'planned' | 'in_progress' | 'completed';
  pathId: PathId;
  concrete_plant?: string;
  m3_per_truck?: number;
}

/** Parse "06:00-07:00" or "06:00" to today's date + start time as ISO string. Returns null if not parseable. */
function plannedStartFromTimePeriod(timePeriod: any, today: Date): string | null {
  if (timePeriod == null) return null;
  const s = String(timePeriod).trim();
  const match = s.match(/^(\d{1,2}):(\d{2})(?:-(\d{1,2}):(\d{2}))?/);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const hour = parseInt(match[1], 10);
  const min = parseInt(match[2], 10);
  const d = new Date(today);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

/** Map ClickUp status to planned | in_progress | completed. "ON THE WAY" = animate; Not started = no marker; ARRIVED/REJECTED/COMPLETE = ended. */
function mapClickUpStatus(task: any, actualArrival: string | null): 'planned' | 'in_progress' | 'completed' {
  const raw = (task.status?.status || '').trim();
  const su = raw.toLowerCase().replace(/\s+/g, ' ');
  if (actualArrival) return 'completed';
  if (CU_STATUS_ENDED.some((end) => su === end || su.includes(end))) return 'completed';
  if (su === 'on the way' || raw.toUpperCase() === 'ON THE WAY' || su === 'in progress' || su.includes('in progress')) return 'in_progress';
  if (su === 'not started' || su === 'to do' || su === 'open' || su === '') return 'planned';
  return 'planned';
}

/** Normalize period label to "HH:00-HH:00" so keys match across API formats. Accepts "10:00-11:00" or "10:0-11:0" or "10:00 - 11:00". */
function normalizePeriodLabel(s: string): string {
  const m = s.trim().replace(/\s+/g, ' ').match(/^(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2})$/);
  if (!m) return s.trim();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(parseInt(m[1]!, 10))}:${pad(parseInt(m[2]!, 10))}-${pad(parseInt(m[3]!, 10))}:${pad(parseInt(m[4]!, 10))}`;
}

/** Resolve Time Period value (dropdown option id, or object with id/name, or array, or "HH:MM-HH:MM" string) to normalized label. */
function resolveTimePeriodLabel(value: any): string | null {
  if (value == null) return null;
  if (Array.isArray(value) && value.length > 0) return resolveTimePeriodLabel(value[0]);
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(s)) return normalizePeriodLabel(s);
    const resolved = CU_TIME_PERIOD_OPTIONS[s] ?? null;
    return resolved ? normalizePeriodLabel(resolved) : null;
  }
  if (typeof value === 'object' && value !== null) {
    const name = (value as any).name;
    if (typeof name === 'string' && name.trim()) return normalizePeriodLabel(name.trim());
    const id = (value as any).id;
    if (typeof id === 'string' && CU_TIME_PERIOD_OPTIONS[id]) return normalizePeriodLabel(CU_TIME_PERIOD_OPTIONS[id]);
  }
  return null;
}

/** Map ClickUp task to trip for simulation. in_progress trips with actual_start_at or planned_start_at get a truck on the map. */
export function clickUpTaskToTrip(task: any): ClickUpTrip {
  const actualStart = parseDateValue(getCustomField(task, CU_FIELD_ACTUAL_DEPARTURE));
  const actualArrival = parseDateValue(getCustomField(task, CU_FIELD_ACTUAL_ARRIVAL));
  const plantOption = getCustomField(task, CU_FIELD_CONCRETE_PLANT);
  const pathId = plantOptionToPathId(plantOption);
  const vehicleId = getCustomField(task, CU_FIELD_TRUCK_LICENSE) ?? task.name ?? '';
  const m3 = getCustomField(task, CU_FIELD_M3_PER_TRUCK);
  const numM3 = typeof m3 === 'number' ? m3 : typeof m3 === 'string' ? parseFloat(m3) : undefined;

  const timePeriodRaw = getCustomField(task, CU_FIELD_TIME_PERIOD);
  const timePeriod = resolveTimePeriodLabel(timePeriodRaw) ?? (timePeriodRaw != null ? String(timePeriodRaw).trim() : null);
  const today = new Date();
  const plannedStart = plannedStartFromTimePeriod(timePeriod ?? timePeriodRaw, today);

  const status = mapClickUpStatus(task, actualArrival);

  const trip: ClickUpTrip = {
    id: String(task.id),
    vehicle_id: String(vehicleId),
    actual_start_at: actualStart,
    actual_arrival_at: actualArrival,
    planned_start_at: plannedStart,
    time_period: timePeriod,
    status,
    pathId,
  };
  if (plantOption != null) trip.concrete_plant = String(plantOption);
  if (numM3 != null && !Number.isNaN(numM3)) trip.m3_per_truck = numM3;
  return trip;
}

export async function fetchFoldersForSpace(spaceId: string = CU_SPACE_ID): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${CLICKUP_API_BASE}/space/${spaceId}/folder?archived=false`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`ClickUp folders ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.folders || []).map((f: any) => ({ id: f.id, name: f.name }));
}

export interface ClickUpListItem {
  id: string;
  name: string;
  content?: string;
}

export async function fetchListsForFolder(folderId: string): Promise<ClickUpListItem[]> {
  const res = await fetch(`${CLICKUP_API_BASE}/folder/${folderId}/list?archived=false`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`ClickUp lists ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.lists || []).map((l: any) => ({
    id: l.id,
    name: l.name || '',
    ...(l.content != null ? { content: String(l.content) } : {}),
  }));
}

/** Lists directly under a space (no folder). Use when space has 0 folders. */
export async function fetchFolderlessListsForSpace(spaceId: string = CU_SPACE_ID): Promise<ClickUpListItem[]> {
  const res = await fetch(`${CLICKUP_API_BASE}/space/${spaceId}/list?archived=false`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`ClickUp folderless lists ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.lists || []).map((l: any) => ({
    id: l.id,
    name: l.name || '',
    ...(l.content != null ? { content: String(l.content) } : {}),
  }));
}

/** Get today in HK as YYYYMMDD for list name/description matching. */
function todayYYYYMMDD(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Pick default list ID: 1) list name starts with today YYYYMMDD, 2) list content contains today YYYYMMDD, 3) CU_DEFAULT_LIST_ID if in list, 4) first list.
 */
export function getDefaultListId(lists: ClickUpListItem[]): string {
  const today = todayYYYYMMDD();
  const byName = lists.find((l) => l.name.startsWith(today));
  if (byName) return byName.id;
  const byContent = lists.find((l) => l.content && l.content.includes(today));
  if (byContent) return byContent.id;
  const fallback = lists.find((l) => l.id === CU_DEFAULT_LIST_ID);
  if (fallback) return fallback.id;
  const first = lists[0];
  return first ? first.id : CU_DEFAULT_LIST_ID;
}

/** Fetch lists for dropdown: use folderless lists if space has no folders, else first folder's lists. Returns lists + defaultListId. */
export async function fetchListsWithDefault(spaceId: string = CU_SPACE_ID): Promise<{
  lists: ClickUpListItem[];
  defaultListId: string;
}> {
  const folders = await fetchFoldersForSpace(spaceId);
  const firstFolder = folders[0];
  let lists: ClickUpListItem[];
  if (firstFolder) {
    lists = await fetchListsForFolder(firstFolder.id);
  } else {
    lists = await fetchFolderlessListsForSpace(spaceId);
  }
  const defaultListId = getDefaultListId(lists);
  return { lists, defaultListId };
}

const CLICKUP_TASKS_PAGE_SIZE = 100;

/** Fetch all tasks for a list (paginated). ClickUp returns max 100 per request. */
export async function fetchTasksForList(listId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 0;
  for (;;) {
    const res = await fetch(
      `${CLICKUP_API_BASE}/list/${listId}/task?archived=false&include_closed=true&subtasks=false&page=${page}`,
      { headers: authHeaders() }
    );
    if (!res.ok) throw new Error(`ClickUp tasks ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const tasks = data.tasks || [];
    all.push(...tasks);
    if (tasks.length < CLICKUP_TASKS_PAGE_SIZE) break;
    page += 1;
  }
  return all;
}

/** Fetch tasks for a list and return as trips (with pathId). */
export async function fetchTripsFromList(listId: string): Promise<ClickUpTrip[]> {
  const tasks = await fetchTasksForList(listId);
  return tasks.map((t: any) => clickUpTaskToTrip(t));
}

/** Hour (0-23) in Hong Kong for an ISO date string. HK = UTC+8, so correct on any server TZ. */
function getHourHK(isoDate: string | null): number | null {
  if (!isoDate) return null;
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return null;
    return (d.getUTCHours() + 8) % 24;
  } catch {
    return null;
  }
}

/** Format hour as period label "HH:00-(HH+1):00". */
function hourToPeriodLabel(hour: number): string {
  const h = hour % 24;
  const next = (h + 1) % 24;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:00-${pad(next)}:00`;
}

/** Ordered period labels (06:00-07:00 through 21:00-22:00) for consistent shortfall. */
const PERIOD_ORDER = [
  '06:00-07:00', '07:00-08:00', '08:00-09:00', '09:00-10:00', '10:00-11:00', '11:00-12:00',
  '12:00-13:00', '13:00-14:00', '14:00-15:00', '15:00-16:00', '16:00-17:00', '17:00-18:00',
  '18:00-19:00', '19:00-20:00', '20:00-21:00', '21:00-22:00',
];

export interface ListSummary {
  ok: boolean;
  totalTasks: number;
  onTheWayCount: number;
  /** On the way with Actual Departure set (matches trucks on map / start-from-clickup count). */
  onTheWayWithDepartureCount: number;
  arrivedCount: number;
  plannedByPeriod: Record<string, number>;
  actualByPeriod: Record<string, number>;
  /** For Planned vs Actual timeline: { hour (7-23), planned, actual } */
  hourlyTimeline: Array<{ hour: number; planned: number; actual: number }>;
  progressPercent: number;
  shortfall: number;
  message: string;
  trips: ClickUpTrip[];
}

/** Get list summary for Concrete Delivery Overview: planned by Time Period, actual by Actual Arrival Time, progress %, shortfall. */
export async function getListSummary(listId: string): Promise<ListSummary> {
  const trips = await fetchTripsFromList(listId);
  const totalTasks = trips.length;
  const arrived = trips.filter((t) => t.status === 'completed');
  const onTheWay = trips.filter((t) => t.status === 'in_progress');
  const onTheWayWithDeparture = trips.filter((t) => t.status === 'in_progress' && t.actual_start_at);
  const arrivedCount = arrived.length;
  const onTheWayCount = onTheWay.length;
  const onTheWayWithDepartureCount = onTheWayWithDeparture.length;

  const plannedByPeriod: Record<string, number> = {};
  for (const t of trips) {
    const raw = t.time_period ?? '';
    const label = raw ? normalizePeriodLabel(raw) : '';
    if (label) plannedByPeriod[label] = (plannedByPeriod[label] ?? 0) + 1;
  }

  const actualByPeriod: Record<string, number> = {};
  for (const t of arrived) {
    const hour = getHourHK(t.actual_arrival_at ?? null);
    if (hour !== null) {
      const label = hourToPeriodLabel(hour);
      actualByPeriod[label] = (actualByPeriod[label] ?? 0) + 1;
    }
  }

  const progressPercent = totalTasks > 0 ? Math.round((arrivedCount / totalTasks) * 100) : 0;

  let shortfall = 0;
  for (const period of PERIOD_ORDER) {
    const planned = plannedByPeriod[period] ?? 0;
    const actual = actualByPeriod[period] ?? 0;
    shortfall += planned - actual;
  }

  const displayStart = 7;
  const displayEnd = 24;
  const hourlyTimeline: Array<{ hour: number; planned: number; actual: number }> = [];
  for (let h = displayStart; h < displayEnd; h++) {
    const label = hourToPeriodLabel(h);
    hourlyTimeline.push({
      hour: h,
      planned: plannedByPeriod[label] ?? 0,
      actual: actualByPeriod[label] ?? 0,
    });
  }

  const message = totalTasks === 0
    ? 'No tasks in this list. Add tasks or select another list.'
    : `Total: ${totalTasks} trips · On the way: ${onTheWayWithDepartureCount} · Arrived: ${arrivedCount} (${progressPercent}%)`;

  return {
    ok: true,
    totalTasks,
    onTheWayCount,
    onTheWayWithDepartureCount,
    arrivedCount,
    plannedByPeriod,
    actualByPeriod,
    hourlyTimeline,
    progressPercent,
    shortfall,
    message,
    trips,
  };
}

export function isClickUpConfigured(): boolean {
  return !!process.env.CLICKUP_API_TOKEN;
}
