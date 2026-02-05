import express from 'express';
import cors from 'cors';
import path from 'path';

const projectRootDir = path.resolve(); // or appRootDir

// ===== IMPORTS =====

import { corridors, updateCorridorState } from './services/tdas';
import { tickSimulation } from './services/simulation';
import { fetchTrafficSpeedMap, speedToState } from './services/trafficService';
import { fetchAdditionalCorridorsFromWFS } from './services/wfsService';



import {
  initializeTrucks,
  updateTruckProgress,
  getTrucks,
  getDeliveryRecords,
  getTotalConcreteDelivered,
  resetSimulation,
  getActiveCount,
  getCompletedCount
} from './services/truckService';

import { calculateRouteDistance, formatTime } from './services/etaService';
import { runTests } from './test-backend';

import {
  loadCorridorsFromGeoJSON,
  getFilteredCorridors,
  buildFilteredCorridors
} from './services/corridorService';



const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let lastTrafficUpdateTime: Date | null = null;

const projectRouteIds = new Set([
  94765, 96983, 118058, 93890, 93888, 164954, 94416, 94948, 272383, 94336,
  95362, 93889, 94949, 94951, 94144, 94145, 97263, 110551, 96730, 279711,
  97261, 96558, 95310, 96560, 97096, 96561, 95308, 97095, 96745, 95306,
  97210, 96747, 96003, 96260, 96754, 95974, 96752, 97133, 95981, 96756,
  95983, 96765, 95987, 96763, 95985, 279712, 95977, 96782, 111898, 98048,
  96220, 96784, 93848, 260731, 96883, 96913, 97271, 96793, 94129, 96791,
  96885, 93855, 96800, 279744, 96932, 96803, 93853, 96926, 96808, 96927,
  93231, 93153, 93151, 96842, 93148, 96860, 93147, 93171, 93166, 110565,
  110564, 111985, 165814, 111986, 111322, 122796, 122797, 165821, 260443,
  165819, 285509, 285514
]);

// ===== HELPER FUNCTION =====
function findRoute(routeId: number): any {
  const allCorridors = getAllCorridors();
  return allCorridors[routeId] || null;
}

// Load corridors on startup
// 1) Always load local project GeoJSON
await loadCorridorsFromGeoJSON();
console.log('✓ Project corridors loaded:', Object.keys(getAllCorridors()).length);

// 2) First TDAS update – guarantees project routes get TDAS
await updateTrafficData();

// 3) Kick off WFS enrichment in the background (do NOT await)
fetchAdditionalCorridorsFromWFS()
  .then(async () => {
    console.log('✓ WFS enrichment finished in background');

    // After WFS enriches allCorridors, run TDAS once more for new routes
    await updateTrafficData();

    const tdasRouteIds = new Set<number>();
    for (const routeIdStr of Object.keys(corridors)) {
      tdasRouteIds.add(Number(routeIdStr));
    }
    buildFilteredCorridors(tdasRouteIds);
    console.log(
      '✓ Filtered corridors rebuilt after WFS, count:',
      Object.keys(getFilteredCorridors()).length
    );
  })
  .catch(err => {
    console.error('⚠ WFS enrichment failed in background:', err);
  });

// 4) Initial filtered corridors using current TDAS + project only
const tdasRouteIds = new Set<number>();
for (const routeIdStr of Object.keys(corridors)) {
  tdasRouteIds.add(Number(routeIdStr));
}
buildFilteredCorridors(tdasRouteIds);
console.log(
  '✓ Filtered corridors ready (project-only / initial TDAS), count:',
  Object.keys(getFilteredCorridors()).length
);

// 5) Start timers
setInterval(updateTrafficData, 60000);
setInterval(() => tickSimulation(1), 1000);


// ===== PAGE ROUTES =====

// Home page - Overview
app.get('/', (req: any, res: any) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Tracking page - Individual route tracking
app.get('/tracking', (req: any, res: any) => {
  res.sendFile(path.join(__dirname, '../public/tracking.html'));
});

// ===== API ENDPOINTS =====

// Get all routes with traffic data (WITH MODE FILTERING)
app.get('/api/routes', (req: any, res: any) => {
  try {
    const mode = req.query.mode || 'overview';
    const allCorridors = getFilteredCorridors(); // will be filtered later

    const features = Object.entries(allCorridors)
      .filter(([routeIdStr]) => {
        const routeId = Number(routeIdStr);
        if (mode === 'focused') {
          return projectRouteIds.has(routeId);   // ONLY project routes
        }
        // overview: ALL filtered routes
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
            TDASSTATE: tdas?.state || 'UNKNOWN',
            TRAFFICSPEED: tdas?.speed ?? null,
            HASTDASDATA: !!tdas,
            ISPROJECT: projectRouteIds.has(routeId),
          },
          geometry: feature.geometry
        };
      });

    res.json({
      type: 'FeatureCollection',
      features,
      metadata: {
        lastUpdate: lastTrafficUpdateTime?.toISOString() || null,
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

// ===== TRAFFIC API =====

// Get traffic data for overview
app.get('/api/traffic', (req: any, res: any) => {
  try {
    const stateMap: any = {};
    const allCorridors = getFilteredCorridors(); // filtered set

    for (const [routeIdStr] of Object.entries(allCorridors)) {
      const routeId = Number(routeIdStr);
      const tdas = corridors[routeId];
      if (!tdas) continue; // only routes with TDAS

      stateMap[routeId] = {
        state: tdas.state,
        speed: tdas.speed
      };
    }

    res.json({
      timestamp: new Date().toISOString(),
      stateMap,
      lastUpdate: lastTrafficUpdateTime?.toISOString()
    });
  } catch (error) {
    console.error('Error in /api/traffic:', error);
    res.status(500).json({ error: String(error) });
  }
});


// Get corridors/routes data
app.get('/api/corridors', (req: any, res: any) => {
  try {
    const allCorridors = getFilteredCorridors();
    const corridorData: any = {};
    for (const [routeIdStr, corridor] of Object.entries(allCorridors)) {
      const routeId = Number(routeIdStr);
      corridorData[routeId] = corridor;
    }

    res.json(corridorData);
  } catch (error) {
    console.error('Error in /api/corridors:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== TRACKING ENDPOINTS =====

// Get tracking status for a route
app.get('/api/tracking/:routeId', (req: any, res: any) => {
  try {
    const routeId = Number(req.params.routeId);
    const route = findRoute(routeId);

    if (!route) {
      const allCorridors = getFilteredCorridors();
      const availableRoutes = Object.values(allCorridors)
        .map((c: any) => c?.properties?.ROUTEID)
        .filter(Boolean)
        .slice(0, 10);

      return res.status(404).json({
        error: `Route ${routeId} not found`,
        availableRoutes: availableRoutes,
        hint: `Try one of these: ${availableRoutes.join(', ')}`
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
      trucks: trucks.map(t => ({
        truckId: t.truckId,
        status: t.status,
        position: t.currentPosition,
        progress: (t.progressRatio * 100).toFixed(1),
        eta: formatTime(t.eta)
      })),
      statistics: {
        totalDelivered: getTotalConcreteDelivered(),
        activeCount: getActiveCount(),
        completedCount: getCompletedCount()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/tracking/:routeId:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Start tracking for a route
app.post('/api/tracking/:routeId/start', (req: any, res: any) => {
  try {
    const routeId = Number(req.params.routeId);
    const truckCount = req.body.truckCount || 5;
    const route = findRoute(routeId);

    if (!route) {
      const allCorridors = getFilteredCorridors();
      const availableRoutes = Object.values(allCorridors)
        .map((c: any) => c?.properties?.ROUTEID)
        .filter(Boolean)
        .slice(0, 10);

      return res.status(404).json({
        error: `Route ${routeId} not found`,
        availableRoutes: availableRoutes
      });
    }

    resetSimulation();
    initializeTrucks(routeId, route.geometry, truckCount);
    const trucks = getTrucks();

    console.log(`📍 Started tracking for route ${routeId} with ${truckCount} trucks`);

    res.json({
      message: 'Simulation started',
      routeId: routeId,
      routeName: route.properties.NAME,
      truckCount: truckCount,
      trucks: trucks.map(t => ({
        truckId: t.truckId,
        eta: formatTime(t.eta)
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/tracking/:routeId/start:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Advance simulation
app.post('/api/simulation/tick', (req: any, res: any) => {
  try {
    const { routeId, deltaSeconds } = req.body;

    if (!routeId || deltaSeconds === undefined) {
      return res.status(400).json({ error: 'Missing routeId or deltaSeconds' });
    }

    const route = findRoute(routeId);
    if (!route) {
      return res.status(404).json({ error: `Route ${routeId} not found` });
    }

    updateTruckProgress(deltaSeconds, route.geometry);
    const trucks = getTrucks();

    res.json({
      timestamp: new Date().toISOString(),
      routeId: routeId,
      deltaSeconds: deltaSeconds,
      trucks: trucks.map(t => ({
        truckId: t.truckId,
        status: t.status,
        position: t.currentPosition,
        progress: (t.progressRatio * 100).toFixed(1),
        eta: formatTime(t.eta)
      })),
      statistics: {
        totalDelivered: getTotalConcreteDelivered(),
        activeCount: getActiveCount(),
        completedCount: getCompletedCount()
      }
    });
  } catch (error) {
    console.error('Error in /api/simulation/tick:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get trucks for a specific route
app.get('/api/trucks/:routeId', (req: any, res: any) => {
  try {
    const routeId = Number(req.params.routeId);
    const trucks = getTrucks().filter(t => t.routeId === routeId);

    res.json({
      routeId: routeId,
      trucks: trucks.map(t => ({
        truckId: t.truckId,
        status: t.status,
        position: t.currentPosition,
        progress: (t.progressRatio * 100).toFixed(1),
        eta: formatTime(t.eta)
      })),
      count: trucks.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/trucks/:routeId:', error);
    res.status(500).json({ error: String(error) });
  }
});

// in updateTrafficData()
import { getAllCorridors } from './services/corridorService';

async function updateTrafficData() {
  try {
    const speedMap = await fetchTrafficSpeedMap();
    console.log('TDAS speedMap size:', speedMap.size);

    const allCorridors = getAllCorridors();
    const corridorIds = Object.keys(allCorridors).map(Number);
    console.log(
      'Corridors available when updating traffic:',
      corridorIds.length
    );
    console.log(
      'Sample corridor IDs:',
      corridorIds.slice(0, 10)
    );

    const sampleSegments: number[] = [];
    for (const [segId] of speedMap.entries()) {
      sampleSegments.push(Number(segId));
      if (sampleSegments.length >= 10) break;
    }
    console.log('Sample TDAS ids:', sampleSegments);

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
    console.log('✓ Updated traffic state for', updateCount, 'routes');
  } catch (err) {
    console.error('Error updating traffic:', err);
  }
}



// Start server only in local/dev (not on Vercel)
if (process.env.VERCEL !== 'true') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Overview at http://localhost:${PORT}`);
    console.log(`🚚 Tracking at http://localhost:${PORT}/tracking`);
    console.log(`📡 API available at http://localhost:${PORT}/api/routes`);
  });
}

// Export Express app for Vercel serverless function
export default app;