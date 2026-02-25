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

import { PROJECT_ROUTE_IDS } from './constants/projectRoutes';


// ===== HELPERS =====

function findRoute(routeId: number): any {
  return getAllCorridors()[routeId] || null;
}

function segDist(a: number[], b: number[]): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  return dx * dx + dy * dy;
}

function stitchProjectRoutes(): { coordinates: number[][]; segmentCount: number } | null {
  const allCorridors = getAllCorridors();
  const segments: Array<{ routeId: number; coords: number[][] }> = [];

  for (const routeId of PROJECT_ROUTE_IDS) {
    const corridor: any = allCorridors[routeId];
    if (!corridor || !corridor.geometry) continue;
    const geomType: string = corridor.geometry.type;
    const geomCoords: any = corridor.geometry.coordinates;

    const coords: number[][] = [];
    if (geomType === 'MultiLineString') {
      for (let li = 0; li < geomCoords.length; li++) {
        const line: any = geomCoords[li];
        for (let ci = 0; ci < line.length; ci++) {
          coords.push(line[ci]);
        }
      }
    } else if (geomType === 'LineString') {
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

    // 1) Auto‑init delivery session so routeGeometry + config exist
    const stitched = stitchProjectRoutes();
    if (stitched && stitched.coordinates.length > 0) {
      const mergedGeometry = {
        type: 'LineString' as const,
        coordinates: stitched.coordinates,
      };

      const targetConfig = await loadTodayDeliveryTarget();

        const targetVolume = targetConfig?.targetVolume ?? 600;
        const trucksPerHour = targetConfig?.trucksPerHour ?? 12;

        // optional: use work_start_hour as session startTime
        const startTime =
          targetConfig?.startTime
            ? new Date(
                `${(new Date())
                  .toISOString()
                  .slice(0, 10)}T${targetConfig.startTime}`
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
          },
          mergedGeometry,
          stitched.segmentCount,
        );

        console.log(
          'Auto delivery session initialized with DB target:',
          targetVolume,
          'm³,',
          trucksPerHour,
          'trucks/hr',
        );
      } else {
        console.warn('No project route geometry found for auto init');
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
      planned_trucks_per_hour
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

  const workStart = row.work_start_hour as string; // '08:00:00'
  const workEnd   = row.work_end_hour as string;   // '23:00:00'
  const trucksPerHour = Number(row.planned_trucks_per_hour) || 0;
  const targetVolume = Number(row.target_concrete_volume) || 0;  // <-- add this

  const [shRaw, smRaw] = workStart.split(':');
  const [ehRaw, emRaw] = workEnd.split(':');

  const sh = Number(shRaw ?? 0);
  const sm = Number(smRaw ?? 0);
  const eh = Number(ehRaw ?? 0);
  const em = Number(emRaw ?? 0);

  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  const workingMinutes = Math.max(0, endMinutes - startMinutes);
  const workingHours = workingMinutes / 60;

  return {
    operationDate: row.operation_date,
    trucksPerHour,
    workingHours,
    workStart,
    workEnd,
    targetVolume,                      // now defined
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
          return PROJECT_ROUTE_IDS.has(routeId);
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

    const stitched = stitchProjectRoutes();
    if (!stitched || stitched.coordinates.length === 0) {
      return res.status(400).json({ error: 'No project route geometry found' });
    }

    const mergedGeometry = {
      type: 'LineString' as const,
      coordinates: stitched.coordinates
    };

    const result = startDeliverySession({
      routeId: 0,
      targetVolume: targetVolume,
      volumePerTruck: volumePerTruck,
      trucksPerHour: trucksPerHour,
      startTime: new Date(),
      defaultSpeed: defaultSpeed
    }, mergedGeometry, stitched.segmentCount);

    res.json(result);
  } catch (error) {
    console.error('Error in /api/delivery/start:', error);
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/delivery/status', (req: any, res: any) => {
  try {
    const status = getDeliveryStatus();
    if (!status) {
      return res.json({ running: false, message: 'No active delivery session' });
    }
    res.json({ running: true, ...status });
  } catch (error) {
    console.error('Error in /api/delivery/status:', error);
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
    const { vehicleId, actualStartAt, corrected } = req.body;
    if (!vehicleId) {
      return res.status(400).json({ error: 'vehicleId is required' });
    }

    const startTime = actualStartAt ? new Date(actualStartAt) : new Date();

    const sql = `
      insert into public.trips (vehicle_id, actual_start_at, status, corrected)
      values ($1, $2, 'in_progress', coalesce($3, false))
      returning *
    `;
    const result = await query(sql, [vehicleId, startTime.toISOString(), corrected]);
    const trip = result.rows[0];

    // Trip Admin → DB only; sim will pick this up on next sync
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

    // 3) Planned totals based on trucks/hour and working hours
    const plannedTripsTotal = Math.round(plan.trucksPerHour * plan.workingHours);

    // 4) Progress by vehicle count, not volume
    const percentComplete =
      plannedTripsTotal > 0
        ? Math.round((completedTrips.length / plannedTripsTotal) * 100)
        : 0;

    // 5) Build per-hour planned + actual (HK time)
    type HourBucket = { hour: number; planned: number; actual: number };

    const buckets: Record<number, HourBucket> = {};

    // Planned windows: from workStart to workEnd (integer hours)
    const shRaw = plan.workStart?.split(':')[0];
    const ehRaw = plan.workEnd?.split(':')[0];

    let startHour = Number.isFinite(Number(shRaw)) ? Number(shRaw) : 8;
    let endHour = Number.isFinite(Number(ehRaw)) ? Number(ehRaw) : 23;

    // fallback to your standard window if parsing fails
    if (!Number.isFinite(startHour)) startHour = 8;
    if (!Number.isFinite(endHour)) endHour = 23;

    // guard against bad data
    startHour = Math.max(0, Math.min(23, startHour));
    endHour = Math.max(startHour + 1, Math.min(24, endHour)); // exclusive


    for (let h = startHour; h < endHour; h++) {
      buckets[h] = {
        hour: h,
        planned: plan.trucksPerHour,
        actual: 0,
      };
    }

    // Fill actual completed trips per hour from actual_arrival_at
    for (const t of completedTrips) {
      if (!t.actual_arrival_at) continue;
      const hkHourSql = `
        select extract(hour from ($1::timestamptz at time zone 'Asia/Hong_Kong')) as h
      `;
      const r = await query(hkHourSql, [t.actual_arrival_at]);
      const h: number = r.rows[0].h;

      if (!buckets[h]) {
        buckets[h] = { hour: h, planned: 0, actual: 0 };
      }
      buckets[h].actual += 1;
    }

    let hourlyTimeline = Object.values(buckets).sort((a, b) => a.hour - b.hour);

    // cumulative shortfall
    let totalPlanned = 0;
    let totalActual = 0;
    hourlyTimeline.forEach(b => {
      totalPlanned += b.planned;
      totalActual += b.actual;
    });
    const totalShortfall = Math.max(0, totalPlanned - totalActual);

    // If still behind, add one delay bucket at endHour+1
    if (totalShortfall > 0 && hourlyTimeline.length > 0) {
      const last = hourlyTimeline[hourlyTimeline.length - 1];
      if (last) {
        const lastHour = last.hour;
        hourlyTimeline.push({
          hour: lastHour + 1,
          planned: 0,
          actual: -totalShortfall,
        });
      }
    }


    res.json({
      ok: true,
      hasPlan: true,
      plan: {
        operationDate: plan.operationDate,
        workStart: plan.workStart,
        workEnd: plan.workEnd,
        trucksPerHour: plan.trucksPerHour,
        workingHours: plan.workingHours,
        plannedTripsTotal,
        targetVolume: plan.targetVolume,          // from loadTodayTruckPlan
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
    console.error('Error in /api/delivery/simple-status:', err);
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