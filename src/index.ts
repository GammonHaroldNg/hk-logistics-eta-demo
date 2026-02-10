import express from 'express';
import cors from 'cors';
import path from 'path';

const projectRootDir = path.resolve();

// ===== IMPORTS =====
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
  startDeliverySession, tickDelivery, getDeliveryStatus,
  stopDelivery, resetDelivery, isDeliveryRunning,
  getTrucks, getTotalConcreteDelivered, getActiveCount,
  getCompletedCount, getDeliveryRecords
} from './services/truckService';

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

// ===== TRAFFIC UPDATE =====
async function updateTrafficData() {
  try {
    const speedMap = await fetchTrafficSpeedMap();
    console.log('TDAS speedMap size:', speedMap.size);

    const allCorridors = getAllCorridors();
    const corridorIds = Object.keys(allCorridors).map(Number);
    console.log('Corridors available when updating traffic:', corridorIds.length);
    console.log('Sample corridor IDs:', corridorIds.slice(0, 10));

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

// ===== STARTUP =====
(async () => {
  try {
    // 1) Load local project GeoJSON
    await loadCorridorsFromGeoJSON();
    console.log('✓ Project corridors loaded:', Object.keys(getAllCorridors()).length);

    // 2) First TDAS update
    await updateTrafficData();

    // 3) WFS enrichment in background
    fetchAdditionalCorridorsFromWFS()
      .then(async () => {
        console.log('✓ WFS enrichment finished in background');
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

    // 4) Initial filtered corridors
    const tdasRouteIds = new Set<number>();
    for (const routeIdStr of Object.keys(corridors)) {
      tdasRouteIds.add(Number(routeIdStr));
    }
    buildFilteredCorridors(tdasRouteIds);
    console.log(
      '✓ Filtered corridors ready, count:',
      Object.keys(getFilteredCorridors()).length
    );

    // 5) Start timers
    setInterval(updateTrafficData, 60000);
    setInterval(() => {
      if (isDeliveryRunning()) {
        tickDelivery(1);
      }
    }, 1000);

    console.log('✓ Server initialized, delivery tick running');
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

// ===== API: ROUTES =====
app.get('/api/routes', (req: any, res: any) => {
  try {
    const mode = req.query.mode || 'overview';
    const filteredCorridors = getFilteredCorridors();

    const features = Object.entries(filteredCorridors)
      .filter(([routeIdStr]) => {
        const routeId = Number(routeIdStr);
        if (mode === 'focused') {
          return projectRouteIds.has(routeId);
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

// ===== API: TRAFFIC =====
app.get('/api/traffic', (req: any, res: any) => {
  try {
    const stateMap: any = {};
    const filteredCorridors = getFilteredCorridors();

    for (const [routeIdStr] of Object.entries(filteredCorridors)) {
      const routeId = Number(routeIdStr);
      const tdas = corridors[routeId];
      if (!tdas) continue;
      stateMap[routeId] = { state: tdas.state, speed: tdas.speed };
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

// ===== API: CORRIDORS =====
app.get('/api/corridors', (req: any, res: any) => {
  try {
    const filteredCorridors = getFilteredCorridors();
    const corridorData: any = {};
    for (const [routeIdStr, corridor] of Object.entries(filteredCorridors)) {
      corridorData[Number(routeIdStr)] = corridor;
    }
    res.json(corridorData);
  } catch (error) {
    console.error('Error in /api/corridors:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: TRACKING (legacy, still works) =====
app.get('/api/tracking/:routeId', (req: any, res: any) => {
  try {
    const routeId = Number(req.params.routeId);
    const route = findRoute(routeId);

    if (!route) {
      const available = Object.keys(getFilteredCorridors()).slice(0, 10);
      return res.status(404).json({
        error: `Route ${routeId} not found`,
        availableRoutes: available,
        hint: `Try one of these: ${available.join(', ')}`
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
    console.error('Error in /api/tracking/:routeId:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== API: DELIVERY (new Session 9) =====
app.post('/api/delivery/start', (req: any, res: any) => {
  try {
    const {
      targetVolume = 600,
      volumePerTruck = 8,
      trucksPerHour = 12,
      defaultSpeed = 40
    } = req.body;

    // Build combined corridor from ALL 92 project routes
    const allCorridors = getAllCorridors();
    const allCoords: [number, number][] = [];
    let segmentCount = 0;

    for (const routeId of projectRouteIds) {
      const corridor = allCorridors[routeId];
      if (!corridor || !corridor.geometry) continue;
      const geom = corridor.geometry;
      const coords = geom.type === 'MultiLineString'
        ? geom.coordinates.flat()
        : geom.coordinates;
      if (coords && coords.length > 0) {
        allCoords.push(...coords);
        segmentCount++;
      }
    }

    if (allCoords.length === 0) {
      return res.status(400).json({ error: 'No project route geometry found' });
    }

    const mergedGeometry = {
      type: 'LineString' as const,
      coordinates: allCoords
    };

    const result = startDeliverySession({
      routeId: 0,
      targetVolume,
      volumePerTruck,
      trucksPerHour,
      startTime: new Date(),
      defaultSpeed
    }, mergedGeometry, segmentCount);

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
app.get('/api/trucks/:routeId', (req: any, res: any) => {
  try {
    const routeId = Number(req.params.routeId);
    const trucks = getTrucks().filter(t => t.routeId === routeId);

    res.json({
      routeId,
      trucks: trucks.map(t => ({
        truckId: t.truckId,
        status: t.status,
        position: t.currentPosition,
        progress: (t.progressRatio * 100).toFixed(1),
        estimatedArrival: t.estimatedArrival.toISOString(),
        elapsedSeconds: t.elapsedSeconds
      })),
      count: trucks.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/trucks/:routeId:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ===== START SERVER =====
if (process.env.VERCEL !== 'true') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Overview at http://localhost:${PORT}`);
    console.log(`🚚 Tracking at http://localhost:${PORT}/tracking`);
    console.log(`📡 API available at http://localhost:${PORT}/api/routes`);
  });
}

export default app;