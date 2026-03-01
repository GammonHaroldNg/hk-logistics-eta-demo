import express from 'express';
import cors from 'cors';
import path from 'path';

import { query } from './db'; // used by db-test only

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
  hydrateFromTrips,
  pruneInactiveTrips,
} from './services/truckService';
import {
  getTodayInProgressTrips,
  getTodayTrips,
  getTodayCompletedTripsWithArrivalHour,
  getCurrentHKHour,
  insertTrip,
  completeTrip,
} from './repositories/tripsRepository';
import {
  getTodayDeliveryTarget,
  getTodayTruckPlan,
  getDeliveryTargets,
} from './repositories/deliveryTargetsRepository';
import { CONFIG } from './config';

const app = express();
const PORT = CONFIG.PORT;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let lastTrafficUpdateTime: Date | null = null;

import { PROJECT_ROUTE_IDS, PROJECT_PATHS, PathId } from './constants/projectRoutes';
import { buildPathGeometries } from './services/pathService';

// ===== HELPERS =====

function findRoute(routeId: number): { geometry: unknown; properties: Record<string, unknown> } | null {
  const corridor = getAllCorridors()[routeId];
  return corridor ?? null;
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

    async function syncTrucksFromDb() {
      if (!process.env.DATABASE_URL) return;
      try {
        const inProgress = await getTodayInProgressTrips();
        await hydrateFromTrips(inProgress as import('./services/truckService').DbTrip[], 40);
        pruneInactiveTrips(inProgress.map((t) => t.id));
        console.log('Synced trucks from DB:', inProgress.length);
      } catch (e) {
        console.error('Failed to sync trucks', e);
      }
    }

    async function loadTodayDeliveryTarget() {
      const target = await getTodayDeliveryTarget();
      if (!target) {
        console.warn('No delivery_targets row for today, using defaults');
        return null;
      }
      return target;
    }

    // 1) Auto‑init delivery session so path geometries + config exist
    const pathGeometries = buildPathGeometries();

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

    setInterval(updateTrafficData, CONFIG.TRAFFIC_UPDATE_INTERVAL_MS);
    setInterval(() => {
      if (isDeliveryRunning()) tickDelivery(1);
    }, CONFIG.DELIVERY_TICK_INTERVAL_MS);
    setInterval(
      () => syncTrucksFromDb().catch((err) => console.error('Failed to sync trucks', err)),
      CONFIG.TRUCK_SYNC_INTERVAL_MS
    );

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
        const pathIds: string[] = [];
        if (PROJECT_PATHS.GAMMON_TM.includes(routeId)) pathIds.push('GAMMON_TM');
        if (PROJECT_PATHS.HKC_TY.includes(routeId)) pathIds.push('HKC_TY');
        return {
          type: 'Feature',
          properties: {
            ...feature.properties,
            ROUTEID: routeId,
            TDASSTATE: tdas ? tdas.state : 'UNKNOWN',
            TRAFFICSPEED: tdas ? tdas.speed : null,
            HASTDASDATA: !!tdas,
            ISPROJECT: PROJECT_ROUTE_IDS.includes(routeId),
            PATH_IDS: pathIds,
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
    const targets = await getDeliveryTargets((date as string) || undefined);
    res.json({ ok: true, targets });
  } catch (err: any) {
    console.error('Error in /api/delivery-targets:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});



// ===== API: TRAFFIC =====

app.get('/api/traffic', (req: any, res: any) => {
  try {
    const stateMap: Record<number, { state: string; speed: number | null }> = {};
    const filtered = getFilteredCorridors();

    for (const routeIdStr of Object.keys(filtered)) {
      const routeId = Number(routeIdStr);
      const tdas = corridors[routeId];
      stateMap[routeId] = tdas
        ? { state: tdas.state, speed: tdas.speed }
        : { state: 'NO_DATA', speed: null };
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

// ===== API: ROUTE ETA (estimated travel time per path to site) =====
// Speed is capped at CONFIG.SPEED_CAP_KMH (70 km/h). No-data segments use CONFIG.DEFAULT_SPEED_NO_DATA_KMH (50 km/h). Length-weighted average.

app.get('/api/route-eta', (req: any, res: any) => {
  try {
    const pathGeometries = buildPathGeometries();
    const allCorridors = getAllCorridors();
    const speedCapKmh = CONFIG.SPEED_CAP_KMH;
    const noDataSpeedKmh = CONFIG.DEFAULT_SPEED_NO_DATA_KMH;
    const result: Record<string, {
      distanceKm: number;
      travelTimeMinutes: number;
      speedKmh: number;
      startPosition?: { lng: number; lat: number };
      label?: string;
    }> = {};

    const pathLabels: Record<string, string> = {
      GAMMON_TM: 'Gammon Tuen Mun Plant',
      HKC_TY: 'HKC Tsing Yi Plant',
    };

    /** HKC TY plant start (correct coordinates). [lng, lat] */
    const HKC_TY_START: [number, number] = [114.08941691, 22.36108321];

    for (const pathId of ['GAMMON_TM', 'HKC_TY'] as PathId[]) {
      const path = pathGeometries[pathId];
      if (!path || !path.coordinates || path.coordinates.length < 2) {
        continue;
      }
      const first = pathId === 'HKC_TY' ? HKC_TY_START : (path.coordinates[0] as [number, number]);
      const distanceKm = calculateRouteDistance({ type: 'LineString', coordinates: path.coordinates });
      const routeIds = PROJECT_PATHS[pathId] || [];

      // Length-weighted average speed, capped at SPEED_CAP_KMH; no-data segments use DEFAULT_SPEED_NO_DATA_KMH
      let totalWeightedSpeed = 0;
      let totalDistance = 0;
      for (const routeId of routeIds) {
        const corridor = allCorridors[routeId] as { geometry?: { type: string; coordinates: number[][] } } | undefined;
        if (!corridor?.geometry) continue;
        const segDist = calculateRouteDistance(corridor.geometry);
        if (segDist <= 0) continue;
        const tdas = corridors[routeId];
        const rawSpeed = tdas?.speed;
        const speed =
          typeof rawSpeed === 'number' && rawSpeed > 0
            ? Math.min(rawSpeed, speedCapKmh)
            : Math.min(noDataSpeedKmh, speedCapKmh);
        totalWeightedSpeed += speed * segDist;
        totalDistance += segDist;
      }
      const speedKmh = totalDistance > 0 ? totalWeightedSpeed / totalDistance : Math.min(noDataSpeedKmh, speedCapKmh);
      const travelTimeHours = distanceKm / speedKmh;
      const travelTimeMinutes = Math.round(travelTimeHours * 60);
      result[pathId] = {
        distanceKm,
        travelTimeMinutes,
        speedKmh,
        ...(first ? { startPosition: { lng: first[0], lat: first[1] } } : {}),
        ...(pathLabels[pathId] ? { label: pathLabels[pathId] } : {}),
      };
    }
    res.json(result);
  } catch (error) {
    console.error('Error in /api/route-eta:', error);
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

    const pathGeometries = buildPathGeometries();

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

// Delivery status (simulation + trucks) - used by frontend for truck markers
app.get('/api/delivery/status', (req: any, res: any) => {
  try {
    const status = getDeliveryStatus();
    const running = isDeliveryRunning();
    if (!status) {
      return res.json({ running: false, trucks: [] });
    }
    res.json({
      running,
      trucks: status.trucks,
      config: status.config,
      progress: status.progress,
      throughput: status.throughput,
      deliveryLog: status.deliveryLog,
      timestamp: status.timestamp,
    });
  } catch (error) {
    console.error('Error in /api/delivery/status:', error);
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
    const plant =
      concretePlant === 'HKC Tsing Yi Plant'
        ? 'HKC Tsing Yi Plant'
        : 'Gammon Tuen Mun Plant';

    const trip = await insertTrip(
      vehicleId,
      startTime,
      plant,
      corrected
    );
    res.status(201).json({ ok: true, trip });
  } catch (err: any) {
    console.error('Error in /api/trips/start', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});


// ===== API: SIMPLE DELIVERY STATUS (trip-count based) =====
app.get('/api/delivery/simple-status', async (req: any, res: any) => {
  try {
    const plan = await getTodayTruckPlan();
    if (!plan) {
      return res.json({
        ok: true,
        hasPlan: false,
        message: 'No delivery_targets row for today',
      });
    }

    // 1) Fetch today’s trips (HK time)
    const displayStartHour = 7;
    const displayEndHour = 24;

    const [allTrips, completedWithHours, nowHour] = await Promise.all([
      getTodayTrips(),
      getTodayCompletedTripsWithArrivalHour(displayStartHour, displayEndHour),
      getCurrentHKHour(),
    ]);

    const completedTrips = allTrips.filter((t) => t.status === 'completed');
    const inProgressTrips = allTrips.filter((t) => t.status === 'in_progress');

    // 3) Planned totals based on per-hour plan from DB
    const plannedTripsTotal = plan.plannedTripsTotal;


    // 4) Progress by vehicle count, not volume
    const percentComplete =
      plannedTripsTotal > 0
        ? Math.round((completedTrips.length / plannedTripsTotal) * 100)
        : 0;


    type HourBucket = { hour: number; planned: number; actual: number };
    const buckets: Record<number, HourBucket> = {};
    for (let h = displayStartHour; h < displayEndHour; h++) {
      buckets[h] = { hour: h, planned: plan.hourlyPlan[h] ?? 0, actual: 0 };
    }
    for (const t of completedWithHours) {
      const bucket = buckets[t.arrival_hour];
      if (bucket) bucket.actual += 1;
    }

    const hourlyTimeline = Object.values(buckets).sort((a, b) => a.hour - b.hour);

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
    const trip = await completeTrip(tripId, arrivalTime, corrected);

    if (!trip) {
      return res.status(404).json({ ok: false, error: 'Trip not found' });
    }
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
    const trips = await getTodayTrips(
      (date as string) || undefined,
      hourFrom ?? undefined,
      hourTo ?? undefined
    );
    res.json({ ok: true, trips });
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