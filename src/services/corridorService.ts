import fs from 'fs';
import path from 'path';
// @ts-ignore
import JSONStream from 'JSONStream';

// Replace any __dirname-based path with process.cwd()
const geoJsonPath = path.join(
  process.cwd(),
  'src',
  'data',
  'project_route.geojson'
);


// Your 92 route IDs from Excel (project routes only)
const PROJECT_ROUTE_IDS = [
  94765, 96983, 118058, 93890, 93888, 164954, 94416, 94948, 272383, 94336,
  95362, 93889, 94949, 94951, 94144, 94145, 97263, 110551, 96730, 279711,
  97261, 96558, 95310, 96560, 97096, 96561, 95308, 97095, 96745, 95306, 97210, 96747,
  96003, 96260, 96754, 95974, 96752, 97133, 95981, 96756, 95983, 96765,
  95987, 96763, 95985, 279712, 95977, 96782, 111898, 98048, 96220, 96784,
  93848, 260731, 96883, 96913, 97271, 96793, 94129, 96791, 96885, 93855,
  96800, 279744, 96932, 96803, 93853, 96926, 96808, 96927, 93231, 93153,
  93151, 96842, 93148, 96860, 93147, 93171, 93166, 110565, 110564, 111985,
  165814, 111986, 111322, 122796, 122797, 165821, 260443, 165819, 285509, 285514
];

interface CorridorFeature {
  type: string;
  properties: Record<string, any>;
  geometry: {
    type: string;
    coordinates: number[][];
  };
}

interface FilteredCorridors {
  [routeId: number]: CorridorFeature;
}

// Store ALL routes here
let allCorridors: FilteredCorridors = {};
let filteredCorridors: FilteredCorridors = {};


export async function loadCorridorsFromGeoJSON(): Promise<void> {
  console.log('Loading project_route.geojson using streaming...');
  return new Promise((resolve, reject) => {
    const projectRouteIdSet = new Set(PROJECT_ROUTE_IDS);
    let totalRoutes = 0;
    let projectCount = 0;

    const startTime = Date.now();
    const stream = fs.createReadStream(geoJsonPath);
    const parser = JSONStream.parse('features.*');

    stream.on('error', (err: any) => {
      reject(new Error(`Failed to read GeoJSON file: ${err.message}`));
    });

    parser.on('data', (feature: CorridorFeature) => {
      try {
        // Extract routeId from description (HTML table)
        const description = feature.properties?.description || '';
        let routeId = null;

        // Pattern 1: ROUTE_ID in HTML tag followed by number
        let match = description.match(/ROUTE_ID<\/[^>]*>[^<]*<[^>]*>(\d+)/);
        if (match) routeId = Number(match[1]);

        // Pattern 2: ROUTE_ID directly followed by digits
        if (!routeId) {
          match = description.match(/ROUTE_ID[^<]*<[^>]*>(\d+)/);
          if (match) routeId = Number(match[1]);
        }

        // Pattern 3: Look for any 5-digit number matching project routes
        if (!routeId) {
          const allNumbers = description.match(/\d+/g) || [];
          for (const num of allNumbers) {
            if (projectRouteIdSet.has(Number(num))) {
              routeId = Number(num);
              break;
            }
          }
        }

        // If we found a routeId, store it
        if (routeId) {
          allCorridors[routeId] = feature;
          totalRoutes++;

          if (projectRouteIdSet.has(routeId)) {
            projectCount++;
          }

          if (totalRoutes % 10000 === 0) {
            console.log(`  Processed ${totalRoutes} routes so far (${projectCount} project routes)...`);
          }
        }
      } catch (err) {
        console.warn('Error processing feature:', err);
      }
    });

    parser.on('end', () => {
      const elapsed = Date.now() - startTime;
      console.log(`✓ Loaded ${totalRoutes} total routes (${projectCount} project routes) in ${(elapsed / 1000).toFixed(1)}s`);
      resolve();
    });

    parser.on('error', (err: any) => {
      reject(new Error(`JSON parsing error: ${err.message}`));
    });

    stream.pipe(parser);
  });
}

export function buildFilteredCorridors(tdasRouteIds: Set<number>): void {
  const projectSet = new Set(PROJECT_ROUTE_IDS);
  const result: FilteredCorridors = {};

  for (const [routeIdStr, feature] of Object.entries(allCorridors)) {
    const routeId = Number(routeIdStr);

    // keep if has TDAS or is project route
    if (tdasRouteIds.has(routeId) || projectSet.has(routeId)) {
      result[routeId] = feature as any;
    }
  }

  filteredCorridors = result;

  console.log(
    `✓ Filtered corridors: ${Object.keys(filteredCorridors).length} routes`
  );
}

// Returns filtered routes
export function getFilteredCorridors(): FilteredCorridors {
  if (Object.keys(filteredCorridors).length > 0) {
    return filteredCorridors;
  }
  return allCorridors;
}

// Get a specific route by ID
export function getCorridorByRouteId(routeId: number): CorridorFeature | null {
  return allCorridors[routeId] || null;
}
