import express from 'express';
import cors from 'cors';
import path from 'path';

import { query } from './db';

import { corridors, updateCorridorState } from './services/tdas';
import { fetchTrafficSpeedMap, speedToState } from './services/trafficService';
import { fetchAdditionalCorridorsFromWFS } from './services/wfsService';
import { calculateRouteDistance, formatTime } from './services/etaService';

import {
  loadCorridorsFromGeoJSON,
  getAllCorridors,
  getFilteredCorridors,
  buildFilteredCorridors
} from './services/corridorService';

import {
  startDeliverySession,
  tickDelivery,
  getDeliveryStatus,
  stopDelivery,
  resetDelivery,
  isDeliveryRunning,
  getTrucks,
  getTotalConcreteDelivered,
  getActiveCount,
  getCompletedCount,
  getDeliveryRecords,
  hydrateFromTrips,
  addTruckFromTrip,
  completeTruckFromDb,
  DbTrip,
  pruneInactiveTrips,
  clearActiveTrucks
} from './services/truckService';


const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let lastTrafficUpdateTime: Date | null = null;

import {
  PROJECT_ROUTE_IDS,
  PROJECT_PATHS,
  PathId,
} from './constants/projectRoutes';



// ===== HELPERS =====

function findRoute(routeId: number): any {
  return getAllCorridors()[routeId] || null;
}

function segDist(a: number[], b: number[]): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  return dx * dx + dy * dy;
}

function stitchPath(routeIds: number[]): { coordinates: number[][]; segmentCount: number } | null {
  const allCorridors = getAllCorridors();
  const segments: Array<{ routeId: number; coords: number[][] }> = [];

  for (const routeId of routeIds) {
    const corridor: any = allCorridors[routeId];
    if (!corridor || !corridor.geometry) continue;
    const geomType: string = corridor.geometry.type;
    const geomCoords: any = corridor.geometry.coordinates;

    const coords: number[][] = [];
    if (geomType === "MultiLineString") {
      for (let li = 0; li < geomCoords.length; li++) {
        const line: any = geomCoords[li];
        for (let ci = 0; ci < line.length; ci++) {
          coords.push(line[ci]);
        }
      }
    } else if (geomType === "LineString") {
      for (let ci = 0; ci < geomCoords.length; ci++) {
        coords.push(geomCoords[ci]);
      }
    }

    if (coords.length >= 2) {
      segments.push({ routeId, coords });
    }
  }

  if (segments.length === 0) return null;

  const START: number[] = [113.99065, 22.41476];
  const used = new Set<number>();
  const orderedCoords: number[][] = [];
  let cursor: number[] = START;

  for (let step = 0; step < segments.length; step++) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestReverse = false;

    for (let i = 0; i < segments.length; i++) {
      if (used.has(i)) continue;
      const seg = segments[i]!;
      const first = seg.coords[0]!;
      const last = seg.coords[seg.coords.length - 1]!;
      const dFirst = segDist(cursor, first);
      const dLast = segDist(cursor, last);

      if (dFirst < bestDist) {
        bestDist = dFirst;
        bestIdx = i;
        bestReverse = false;
      }
      if (dLast < bestDist) {
        bestDist = dLast;
        bestIdx = i;
        bestReverse = true;
      }
    }

    if (bestIdx === -1) break;
    used.add(bestIdx);

    const matched = segments[bestIdx]!;
    const segCoords = bestReverse ? matched.coords.slice().reverse() : matched.coords;

    if (orderedCoords.length > 0) {
      const lastAdded = orderedCoords[orderedCoords.length - 1]!;
      const firstCoord = segCoords[0]!;
      const startIdx = segDist(lastAdded, firstCoord) < 1e-10 ? 1 : 0;
      for (let ci = startIdx; ci < segCoords.length; ci++) {
        orderedCoords.push(segCoords[ci]!);
      }
    } else {
      for (let ci = 0; ci < segCoords.length; ci++) {
        orderedCoords.push(segCoords[ci]!);
      }
    }

    cursor = orderedCoords[orderedCoords.length - 1]!;
  }

  console.log('Stitched ' + used.size + '/' + segments.length + ' segments, ' + orderedCoords.length + ' total coords');
  return { coordinates: orderedCoords, segmentCount: used.size };
}


// ===== TRAFFIC UPDATE =====

async function updateTrafficData(): Promise<void> {
  try {
    const speedMap = await fetchTrafficSpeedMap();
    console.log('TDAS speedMap size:', speedMap.size);

    const allCorridors = getAllCorridors();
    const corridorIds = Object.keys(allCorridors).map(Number);
    console.log('Corridors available when updating traffic:', corridorIds.length);

    let updateCount = 0;
    for (const [segmentId, data] of speedMap.entries()) {
      const routeId = Number(segmentId);
      const state = speedToState(data.speed);
      if (allCorridors[routeId]) {
        updateCorridorState(routeId, state, data.speed);
        updateCount++;
      }
    }

    lastTrafficUpdateTime = new Date();
    console.log('Updated traffic state for', updateCount, 'routes');
  } catch (err) {
    console.error('Error updating traffic:', err);
  }
}

// ===== STARTUP =====

(async () => {
  try {
    await loadCorridorsFromGeoJSON();
    console.log('Project corridors loaded:', Object.keys(getAllCorridors()).length);

    await updateTrafficData();

    // Helper: rebuild trucks in RAM from today's in_progress trips in DB
    // inside the startup IIFE, after updateTrafficData()
    async function syncTrucksFromDb() {
      if (!process.env.DATABASE_URL) return;

      const sql = `
        select
          id,
          vehicle_id,
          actual_start_at,
          actual_arrival_at,
          status,
          corrected
        from public.trips
        where (actual_start_at at time zone 'Asia/Hong_Kong')::date =
              (now() at time zone 'Asia/Hong_Kong')::date
        order by actual_start_at asc
      `;
      const result = await query(sql);
      const rows = result.rows as DbTrip[];

      const inProgress = rows.filter(t => t.status === 'in_progress');

      // Add/update all in_progress trips
      await hydrateFromTrips(inProgress, 40);

      // Remove trucks whose trips are no longer in_progress
      const activeIds = inProgress.map(t => t.id);
      pruneInactiveTrips(activeIds);

      console.log('Synced trucks from DB:', activeIds.length);
    }

    async function loadTodayDeliveryTarget() {
      const sql = `
        select
          operation_date,
          target_concrete_volume,
          work_start_hour,
          work_end_hour,
          planned_trucks_per_hour
        from public.delivery_targets
        where operation_date = (now() at time zone 'Asia/Hong_Kong')::date
        order by updated_at desc, created_at desc
        limit 1
      `;

      const result = await query(sql);
      const row = result.rows[0];

      if (!row) {
        console.warn('No delivery_targets row for today, using defaults');
        return null;
      }

      return {
        targetVolume: Number(row.target_concrete_volume) || 600,
        trucksPerHour: Number(row.planned_trucks_per_hour) || 12,
        startTime: row.work_start_hour as string,
        endTime: row.work_end_hour as string,
      };
    }

    // 1) Auto‑init delivery session so path geometries + config exist
    const pathGeometries: Record<PathId, { coordinates: number[][]; segmentCount: number } | null> = {
      GAMMON_TM: stitchPath(PROJECT_PATHS.GAMMON_TM),
      HKC_TY: stitchPath(PROJECT_PATHS.HKC_TY),
      FUTURE_PATH: stitchPath(PROJECT_PATHS.FUTURE_PATH),
    };

    const base = pathGeometries.GAMMON_TM;
    if (base && base.coordinates.length > 0) {
      const targetConfig = await loadTodayDeliveryTarget();

      const targetVolume = targetConfig?.targetVolume ?? 600;
      const trucksPerHour = targetConfig?.trucksPerHour ?? 12;

      const startTime =
        targetConfig?.startTime
          ? new Date(
              `${new Date().toISOString().slice(0, 10)}T${targetConfig.startTime}`,
            )
          : new Date();

      startDeliverySession(
        {
          routeId: 0,
          targetVolume,
          volumePerTruck: 8,
          trucksPerHour,
          startTime,
          defaultSpeed: 40,
          // truckService will now also expect pathGeometries; you’ll add that there
        },
        pathGeometries,
      );

      console.log(
        'Auto delivery session initialized with DB target:',
        targetVolume,
        'm³,',
        trucksPerHour,
        'trucks/hr',
      );
    } else {
      console.warn('No Gammon TM path geometry found for auto init');
    }



    // existing WFS enrichment
    fetchAdditionalCorridorsFromWFS()
      .then(async () => {
        console.log('WFS enrichment finished');
        await updateTrafficData();
        const tdasRouteIds = new Set<number>();
        for (const routeIdStr of Object.keys(corridors)) {
          tdasRouteIds.add(Number(routeIdStr));
        }
        buildFilteredCorridors(tdasRouteIds);
        console.log(
          'Filtered corridors rebuilt after WFS:',
          Object.keys(getFilteredCorridors()).length,
        );

        await syncTrucksFromDb();

      })
      .catch((err: any) => {
        console.error('WFS enrichment failed:', err);
      });

    const tdasRouteIds = new Set<number>();
    for (const routeIdStr of Object.keys(corridors)) {
      tdasRouteIds.add(Number(routeIdStr));
    }
    buildFilteredCorridors(tdasRouteIds);
    console.log('Filtered corridors ready:', Object.keys(getFilteredCorridors()).length);

    setInterval(updateTrafficData, 60000);
    setInterval(() => {
      if (isDeliveryRunning()) {
        tickDelivery(1);
      }
    }, 1000);

    setInterval(() => {
      syncTrucksFromDb().catch(err => console.error('Failed to sync trucks', err));
    }, 5000);

    // 2) Initial sync of trucks from DB
    try {
      await syncTrucksFromDb();
    } catch (e) {
      console.error('Failed to sync trucks from trips', e);
    }

    console.log('Server initialized, delivery tick running');
  } catch (err) {
    console.error('Failed to initialize app:', err);
  }
})();

async function loadTodayTruckPlan() {
  const sql = `
    select
      operation_date,
      target_concrete_volume,
      work_start_hour,
      work_end_hour,
      planned_trucks_per_hour,
      h07_08, h08_09, h09_10, h10_11,
      h11_12, h12_13, h13_14, h14_15,
      h15_16, h16_17, h17_18, h18_19,
      h19_20, h20_21, h21_22, h22_23,
      h23_00
    from public.delivery_targets
    where operation_date = (now() at time zone 'Asia/Hong_Kong')::date
    order by updated_at desc, created_at desc
    limit 1
  `;
  const result = await query(sql);
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const workStart = row.work_start_hour as string;
  const workEnd   = row.work_end_hour as string;

  // per-hour plan (null -> 0)
  const hourlyPlan: Record<number, number> = {
    7:  Number(row.h07_08 || 0),
    8:  Number(row.h08_09 || 0),
    9:  Number(row.h09_10 || 0),
    10: Number(row.h10_11 || 0),
    11: Number(row.h11_12 || 0),
    12: Number(row.h12_13 || 0),
    13: Number(row.h13_14 || 0),
    14: Number(row.h14_15 || 0),
    15: Number(row.h15_16 || 0),
    16: Number(row.h16_17 || 0),
    17: Number(row.h17_18 || 0),
    18: Number(row.h18_19 || 0),
    19: Number(row.h19_20 || 0),
    20: Number(row.h20_21 || 0),
    21: Number(row.h21_22 || 0),
    22: Number(row.h22_23 || 0),
    23: Number(row.h23_00 || 0),
  };

  const plannedTripsTotal = Object.values(hourlyPlan).reduce((s, v) => s + v, 0);

  // keep old trucksPerHour / workingHours for backwards‑compat
  const [shRaw, smRaw] = workStart.split(':');
  const [ehRaw, emRaw] = workEnd.split(':');
  const sh = Number(shRaw ?? 0);
  const sm = Number(smRaw ?? 0);
  const eh = Number(ehRaw ?? 0);
  const em = Number(emRaw ?? 0);
  const startMinutes = sh * 60 + sm;
  const endMinutes   = eh * 60 + em;
  const workingMinutes = Math.max(0, endMinutes - startMinutes);
  const workingHours   = workingMinutes / 60;

  return {
    operationDate: row.operation_date,
    trucksPerHour: Number(row.planned_trucks_per_hour) || 0, // legacy
    workingHours,
    workStart,
    workEnd,
    targetVolume: Number(row.target_concrete_volume) || 0,
    hourlyPlan,
    plannedTripsTotal,
  };
}


// ===== PAGE ROUTES =====

app.get('/', (req: any, res: any) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/tracking', (req: any, res: any) => {
  res.sendFile(path.join(__dirname, '../public/tracking.html'));
});

app.get('/trips', (req: any, res: any) => {
  res.sendFile(path.join(__dirname, '../public/trips.html'));
});

// ===== API: ROUTES =====

app.get('/api/routes', (req: any, res: any) => {
  try {
    const mode = req.query.mode || 'overview';
    const filtered = getFilteredCorridors();

    const features = Object.entries(filtered)
      .filter(([routeIdStr]) => {
        const routeId = Number(routeIdStr);
        if (mode === 'focused') {
          return PROJECT_ROUTE_IDS.includes(routeId);
        }
        return true;
      })

      .map(([routeIdStr, feature]: [string, any]) => {
        const routeId = Number(routeIdStr);
        const tdas = corridors[routeId];
        return {
          type: 'Feature',
          properties: {
            ...feature.properties,
            ROUTEID: routeId,
            TDASSTATE: tdas ? tdas.state : 'UNKNOWN',
            TRAFFICSPEED: tdas ? tdas.speed : null,
            HASTDASDATA: !!tdas,
            ISPROJECT: PROJECT_ROUTE_IDS.has(routeId),
          },
          geometry: feature.geometry
        };
      });

    res.json({
      type: 'FeatureCollection',
      features,
      metadata: {
        lastUpdate: lastTrafficUpdateTime ? lastTrafficUpdateTime.toISOString() : null,
        totalRoutes: features.length,
        mode,
        projectRoutes: features.filter((f: any) => f.properties.ISPROJECT).length
      }
    });
  } catch (error) {
    console.error('Error in /api/routes:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: DELIVERY TARGETS =====
app.get('/api/delivery-targets', async (req: any, res: any) => {
  try {
    const { date } = req.query;

    const sql = `
      with params as (
        select
          $1::date as hk_date
      )
      select
        operation_date,
        target_concrete_volume,
        work_start_hour,
        work_end_hour,
        planned_trucks_per_hour
      from public.delivery_targets
      cross join params
      where (
        -- if hk_date is null => no filtering (show all)
        params.hk_date is null
        or operation_date = params.hk_date
      )
      order by operation_date asc
      limit 365;
    `;

    const result = await query(sql, [date || null]);
    res.json({ ok: true, targets: result.rows });
  } catch (err: any) {
    console.error('Error in /api/delivery-targets:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});



// ===== API: TRAFFIC =====

app.get('/api/traffic', (req: any, res: any) => {
  try {
    const stateMap: any = {};
    const filtered = getFilteredCorridors();

    for (const routeIdStr of Object.keys(filtered)) {
      const routeId = Number(routeIdStr);
      const tdas = corridors[routeId];
      if (!tdas) continue;
      stateMap[routeId] = { state: tdas.state, speed: tdas.speed };
    }

    res.json({
      timestamp: new Date().toISOString(),
      stateMap,
      lastUpdate: lastTrafficUpdateTime ? lastTrafficUpdateTime.toISOString() : null
    });
  } catch (error) {
    console.error('Error in /api/traffic:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: CORRIDORS =====

app.get('/api/corridors', (req: any, res: any) => {
  try {
    const filtered = getFilteredCorridors();
    const corridorData: any = {};
    for (const routeIdStr of Object.keys(filtered)) {
      corridorData[Number(routeIdStr)] = (filtered as any)[routeIdStr];
    }
    res.json(corridorData);
  } catch (error) {
    console.error('Error in /api/corridors:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: TRACKING (legacy) =====

app.get('/api/tracking/:routeId', (req: any, res: any) => {
  try {
    const routeId = Number(req.params.routeId);
    const route = findRoute(routeId);

    if (!route) {
      const available = Object.keys(getFilteredCorridors()).slice(0, 10);
      return res.status(404).json({
        error: 'Route ' + routeId + ' not found',
        availableRoutes: available
      });
    }

    const distance = calculateRouteDistance(route.geometry);
    const estimatedTime = (distance / 40) * 3600;
    const trucks = getTrucks();

    res.json({
      route: {
        ROUTEID: routeId,
        name: route.properties.NAME || 'Unknown',
        distance: distance.toFixed(2),
        estimatedTime: formatTime(estimatedTime)
      },
      trucks: trucks.map((t: any) => ({
        truckId: t.truckId,
        status: t.status,
        position: t.currentPosition,
        progress: (t.progressRatio * 100).toFixed(1),
        estimatedArrival: t.estimatedArrival.toISOString(),
        elapsedSeconds: t.elapsedSeconds
      })),
      statistics: {
        totalDelivered: getTotalConcreteDelivered(),
        activeCount: getActiveCount(),
        completedCount: getCompletedCount()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/tracking:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: DELIVERY =====

app.post('/api/delivery/start', (req: any, res: any) => {
  try {
    const targetVolume = req.body.targetVolume || 600;
    const volumePerTruck = req.body.volumePerTruck || 8;
    const trucksPerHour = req.body.trucksPerHour || 12;
    const defaultSpeed = req.body.defaultSpeed || 40;

    // For now, always stitch all known paths; later you can choose per request
    const pathGeometries: Record<PathId, { coordinates: number[][]; segmentCount: number } | null> = {
      GAMMON_TM: stitchPath(PROJECT_PATHS.GAMMON_TM),
      HKC_TY: stitchPath(PROJECT_PATHS.HKC_TY),
      FUTURE_PATH: stitchPath(PROJECT_PATHS.FUTURE_PATH),
    };

    const base = pathGeometries.GAMMON_TM || pathGeometries.HKC_TY;
    if (!base || base.coordinates.length === 0) {
      return res.status(400).json({ error: 'No path geometry found' });
    }

    const result = startDeliverySession(
      {
        routeId: 0,
        targetVolume,
        volumePerTruck,
        trucksPerHour,
        startTime: new Date(),
        defaultSpeed,
      },
      pathGeometries,
    );

    res.json(result);
  } catch (error) {
    console.error('Error in /api/delivery/start:', error);
    res.status(500).json({ error: String(error) });
  }
});


app.post('/api/delivery/stop', (req: any, res: any) => {
  try {
    stopDelivery();
    const status = getDeliveryStatus();
    res.json({ message: 'Delivery stopped', ...status });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/delivery/reset', (req: any, res: any) => {
  try {
    resetDelivery();
    res.json({ message: 'Delivery session reset' });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: TRUCKS =====

app.get('/api/trucks/:routeId', (req, res) => {
  try {
    const trucks = getTrucks(); // no filter
    res.json({
      routeId: Number(req.params.routeId),
      trucks: trucks.map(t => ({
        truckId: t.truckId,
        status: t.status,
        position: t.currentPosition,
        progress: (t.progressRatio * 100).toFixed(1),
        estimatedArrival: t.estimatedArrival.toISOString(),
        elapsedSeconds: t.elapsedSeconds,
      })),
      count: trucks.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in /api/trucks:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: TRIPS =====

// Start a trip
app.post('/api/trips/start', async (req: any, res: any) => {
  try {
    const { vehicleId, actualStartAt, corrected, concretePlant } = req.body;
    if (!vehicleId) {
      return res.status(400).json({ error: 'vehicleId is required' });
    }

    const startTime = actualStartAt ? new Date(actualStartAt) : new Date();

    // Only allow the two plants; default to Gammon if anything else
    const plant =
      concretePlant === 'HKC Tsing Yi Plant'
        ? 'HKC Tsing Yi Plant'
        : 'Gammon Tuen Mun Plant';

    const sql = `
      insert into public.trips (
        vehicle_id,
        actual_start_at,
        concrete_plant,
        status,
        corrected
      )
      values ($1, $2, $3, 'in_progress', coalesce($4, false))
      returning *
    `;
    const result = await query(sql, [
      vehicleId,
      startTime.toISOString(),
      plant,
      corrected,
    ]);
    const trip = result.rows[0];

    res.status(201).json({ ok: true, trip });
  } catch (err: any) {
    console.error('Error in /api/trips/start', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});


// ===== API: SIMPLE DELIVERY STATUS (trip-count based) =====
app.get('/api/delivery/simple-status', async (req: any, res: any) => {
  try {
    const plan = await loadTodayTruckPlan();
    if (!plan) {
      return res.json({
        ok: true,
        hasPlan: false,
        message: 'No delivery_targets row for today',
      });
    }

    // 1) Fetch today’s trips (HK time)
    const tripsSql = `
      select
        id,
        vehicle_id,
        actual_start_at,
        actual_arrival_at,
        status
      from public.trips
      where (actual_start_at at time zone 'Asia/Hong_Kong')::date =
            (now() at time zone 'Asia/Hong_Kong')::date
    `;
    const tripsResult = await query(tripsSql);
    const trips = tripsResult.rows;

    // 2) Count completed + in_progress
    const completedTrips = trips.filter((t: any) => t.status === 'completed');
    const inProgressTrips = trips.filter((t: any) => t.status === 'in_progress');

    // 3) Planned totals based on per-hour plan from DB
    const plannedTripsTotal = plan.plannedTripsTotal;


    // 4) Progress by vehicle count, not volume
    const percentComplete =
      plannedTripsTotal > 0
        ? Math.round((completedTrips.length / plannedTripsTotal) * 100)
        : 0;


    // 5 Build per-hour planned / actual HK time with display window 7–24
      type HourBucket = { hour: number; planned: number; actual: number };
      const buckets: Record<number, HourBucket> = {};

      const displayStartHour = 7;
      const displayEndHour = 24;

    // 5a: pre-fill planned counts from hourlyPlan for 7..23
    for (let h = displayStartHour; h < displayEndHour; h++) {
      const planned = plan.hourlyPlan[h] ?? 0;
      buckets[h] = { hour: h, planned, actual: 0 };
    }

    // 6 Fill actual completed trips per hour (HK time)
    for (const t of completedTrips) {
      if (!t.actual_arrival_at) continue;

      const hkHourSql = `
        select extract(hour from $1::timestamptz at time zone 'Asia/Hong_Kong') as h
      `;
      const r = await query(hkHourSql, [t.actual_arrival_at]);
      const h = Number(r.rows[0].h);

      if (h < displayStartHour || h >= displayEndHour) continue;

      const bucket = buckets[h];
      if (!bucket) continue;             // satisfies TS

      bucket.actual += 1;
    }



    // 7 Build sorted timeline and compute cumulative shortfall up to "now"
    let hourlyTimeline = Object.values(buckets).sort((a, b) => a.hour - b.hour);

    // current HK hour (integer)
    const nowHkSql = `select extract(hour from now() at time zone 'Asia/Hong_Kong') as h`;
    const nowRes = await query(nowHkSql);
    const nowHour = Number(nowRes.rows[0].h);

    let totalPlannedSoFar = 0;
    let totalActualSoFar = 0;

    for (const b of hourlyTimeline) {
      // Only count hours strictly before "now" for the shortfall aggregation
      if (b.hour < nowHour) {
        totalPlannedSoFar += b.planned;
        totalActualSoFar += b.actual;
      }
    }

    const totalShortfall = Math.max(0, totalPlannedSoFar - totalActualSoFar);

    // 9 Send response
    return res.json({
      ok: true,
      hasPlan: true,
      plan: {
        operationDate: plan.operationDate,
        workStart: plan.workStart,
        workEnd: plan.workEnd,
        trucksPerHour: plan.trucksPerHour,  // legacy / optional
        workingHours: plan.workingHours,
        plannedTripsTotal,
        targetVolume: plan.targetVolume,
        hourlyPlan: plan.hourlyPlan,       // send to frontend if you want it there too
      },
      tripsSummary: {
        completedCount: completedTrips.length,
        inProgressCount: inProgressTrips.length,
        percentComplete,
        hourlyTimeline,
        totalShortfall,
      },
    });
  } catch (err: any) {
    console.error('Error in /api/delivery/simple-status', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Mark trip as arrived
app.post('/api/trips/:id/arrive', async (req: any, res: any) => {
  try {
    const tripId = req.params.id;
    const { actualArrivalAt, corrected } = req.body;

    if (!tripId) {
      return res.status(400).json({ error: 'trip id is required in URL' });
    }

    const arrivalTime = actualArrivalAt ? new Date(actualArrivalAt) : new Date();

    const sql = `
      update public.trips
      set actual_arrival_at = $1,
          status = 'completed',
          corrected = coalesce($2, corrected),
          updated_at = now()
      where id = $3
      returning *
    `;
    const result = await query(sql, [arrivalTime.toISOString(), corrected, tripId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Trip not found' });
    }

    const trip = result.rows[0];

    // Trip Admin → DB only; sim will drop this on next sync
    res.json({ ok: true, trip });
  } catch (err: any) {
    console.error('Error in /api/trips/:id/arrive', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});


// ===== API: TRIPS TODAY (with HK date & hour filters) =====
app.get('/api/trips/today', async (req: any, res: any) => {
  try {
    const { date, hourFrom, hourTo } = req.query;

    const sql = `
      with params as (
        select
          coalesce(
            $1::date,
            (now() at time zone 'Asia/Hong_Kong')::date
          ) as hk_date,
          $2::int as hour_from,
          $3::int as hour_to
      )
      select t.*
      from public.trips t
      cross join params
      where
        -- Hong Kong local date of actual_start_at must match selected date
        (t.actual_start_at at time zone 'Asia/Hong_Kong')::date = params.hk_date
        -- Optional lower bound on hour
        and (
          params.hour_from is null
          or extract(hour from (t.actual_start_at at time zone 'Asia/Hong_Kong')) >= params.hour_from
        )
        -- Optional upper bound on hour (exclusive)
        and (
          params.hour_to is null
          or extract(hour from (t.actual_start_at at time zone 'Asia/Hong_Kong')) < params.hour_to
        )
      order by t.actual_start_at asc
      limit 200;
    `;

    const result = await query(sql, [
      date || null,          // $1: 'YYYY-MM-DD' or null
      hourFrom ?? null,      // $2: '0'..'23' or null
      hourTo ?? null         // $3: '1'..'24' or null
    ]);

    res.json({ ok: true, trips: result.rows });
  } catch (err: any) {
    console.error('Error in /api/trips/today:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});




app.get('/api/db-test', async (req: any, res: any) => {
  try {
    const result = await query('select now() as now');
    res.json({ ok: true, now: result.rows[0].now });
  } catch (err: any) {
    console.error('DB test error object:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});



// ===== START SERVER =====

if (process.env.VERCEL !== 'true') {
  app.listen(PORT, () => {
    console.log('Server running at http://localhost:' + PORT);
  });
}

export default app;