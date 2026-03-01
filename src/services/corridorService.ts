import fs from 'fs';
import path from 'path';
// @ts-ignore
import JSONStream from 'JSONStream';
import { PROJECT_ROUTE_IDS } from '../constants/projectRoutes';

const geoJsonPath = path.join(process.cwd(), 'src', 'data', 'project_route.geojson');

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

// After allCorridors / filteredCorridors declarations
export function getAllCorridors(): FilteredCorridors {
  return allCorridors;
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

// corridorService.ts

export function addCorridors(newCorridors: FilteredCorridors): void {
  for (const [routeIdStr, feature] of Object.entries(newCorridors)) {
    const routeId = Number(routeIdStr);
    allCorridors[routeId] = feature as CorridorFeature;
  }
}