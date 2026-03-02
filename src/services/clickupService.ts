// src/services/clickupService.ts — Fetch lists/tasks from ClickUp and map to simulation trips
// Uses global fetch (Node 18+)
import {
  CU_FIELD_TRUCK_LICENSE,
  CU_FIELD_CONCRETE_PLANT,
  CU_FIELD_ACTUAL_DEPARTURE,
  CU_FIELD_ACTUAL_ARRIVAL,
  CU_FIELD_M3_PER_TRUCK,
  CU_OPT_GAMMON_TM,
  CU_OPT_HKC_TY,
  CU_SPACE_ID,
  CU_DEFAULT_LIST_ID,
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

/** Parse ClickUp date (ms or ISO string) to ISO string for actual_start_at/actual_arrival_at */
function parseDateValue(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
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
  status: 'planned' | 'in_progress' | 'completed';
  pathId: PathId;
  concrete_plant?: string;
  m3_per_truck?: number;
}

/** Map ClickUp task to trip for simulation. Only in_progress trips with actual_start_at are used for trucks. */
export function clickUpTaskToTrip(task: any): ClickUpTrip {
  const actualStart = parseDateValue(getCustomField(task, CU_FIELD_ACTUAL_DEPARTURE));
  const actualArrival = parseDateValue(getCustomField(task, CU_FIELD_ACTUAL_ARRIVAL));
  const plantOption = getCustomField(task, CU_FIELD_CONCRETE_PLANT);
  const pathId = plantOptionToPathId(plantOption);
  const vehicleId = getCustomField(task, CU_FIELD_TRUCK_LICENSE) ?? task.name ?? '';
  const m3 = getCustomField(task, CU_FIELD_M3_PER_TRUCK);
  const numM3 = typeof m3 === 'number' ? m3 : typeof m3 === 'string' ? parseFloat(m3) : undefined;

  let status: 'planned' | 'in_progress' | 'completed' = 'planned';
  const su = (task.status?.status || '').toLowerCase();
  if (su === 'complete' || su === 'closed' || actualArrival) status = 'completed';
  else if (su === 'in progress' || actualStart) status = 'in_progress';

  const trip: ClickUpTrip = {
    id: String(task.id),
    vehicle_id: String(vehicleId),
    actual_start_at: actualStart,
    actual_arrival_at: actualArrival,
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

/** Fetch folders then all lists from first folder (for dropdown). Returns lists + defaultListId. */
export async function fetchListsWithDefault(spaceId: string = CU_SPACE_ID): Promise<{
  lists: ClickUpListItem[];
  defaultListId: string;
}> {
  const folders = await fetchFoldersForSpace(spaceId);
  const firstFolder = folders[0];
  if (!firstFolder) {
    return { lists: [], defaultListId: CU_DEFAULT_LIST_ID };
  }
  const lists = await fetchListsForFolder(firstFolder.id);
  const defaultListId = getDefaultListId(lists);
  return { lists, defaultListId };
}

export async function fetchTasksForList(listId: string): Promise<any[]> {
  const res = await fetch(
    `${CLICKUP_API_BASE}/list/${listId}/task?archived=false&include_closed=true&subtasks=false`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`ClickUp tasks ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.tasks || [];
}

/** Fetch tasks for a list and return as trips (with pathId). Only trips with actual_start_at are suitable for in_progress simulation. */
export async function fetchTripsFromList(listId: string): Promise<ClickUpTrip[]> {
  const tasks = await fetchTasksForList(listId);
  return tasks.map((t: any) => clickUpTaskToTrip(t));
}

export function isClickUpConfigured(): boolean {
  return !!process.env.CLICKUP_API_TOKEN;
}
