import { getAllCorridors } from './corridorService';
import { PROJECT_PATHS, PathId } from '../constants/projectRoutes';

export type StitchedPath = { coordinates: number[][]; segmentCount: number } | null;

function segDist(a: number[], b: number[]): number {
  const dx = (a[0] ?? 0) - (b[0] ?? 0);
  const dy = (a[1] ?? 0) - (b[1] ?? 0);
  return dx * dx + dy * dy;
}

/**
 * Stitch corridor segments into a continuous path ordered by proximity.
 */
export function stitchPath(routeIds: number[]): StitchedPath {
  const allCorridors = getAllCorridors();
  const segments: Array<{ routeId: number; coords: number[][] }> = [];

  for (const routeId of routeIds) {
    const corridor = allCorridors[routeId] as { geometry?: { type: string; coordinates: unknown } } | undefined;
    if (!corridor?.geometry) continue;

    const geomType = corridor.geometry.type;
    const geomCoords = corridor.geometry.coordinates as number[][] | number[][][];

    const coords: number[][] = [];
    if (geomType === 'MultiLineString') {
      for (const line of geomCoords as number[][][]) {
        for (const coord of line) {
          coords.push(coord);
        }
      }
    } else if (geomType === 'LineString') {
      for (const coord of geomCoords as number[][]) {
        coords.push(coord);
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
  let cursor = [...START];

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
      orderedCoords.push(...segCoords);
    }

    cursor = orderedCoords[orderedCoords.length - 1]!;
  }

  console.log(`Stitched ${used.size}/${segments.length} segments, ${orderedCoords.length} total coords`);
  return { coordinates: orderedCoords, segmentCount: used.size };
}

/**
 * Build path geometries for all project paths.
 */
export function buildPathGeometries(): Record<PathId, StitchedPath> {
  return {
    GAMMON_TM: stitchPath(PROJECT_PATHS.GAMMON_TM),
    HKC_TY: stitchPath(PROJECT_PATHS.HKC_TY),
    FUTURE_PATH: stitchPath(PROJECT_PATHS.FUTURE_PATH),
  };
}
