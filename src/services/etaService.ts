/**
 * Calculate total route distance using Haversine formula
 */
export function calculateRouteDistance(lineString: any): number {
  const coords = (lineString.coordinates || []) as [number, number][];
  let distance = 0;
  
  for (let i = 0; i < coords.length - 1; i++) {
    const coord1 = coords[i];
    const coord2 = coords[i + 1];
    
    if (!coord1 || !coord2) continue;
    
    distance += haversineDistance(coord1[1], coord1[0], coord2[1], coord2[0]);
  }
  
  return distance; // km
}

/**
 * Calculate remaining ETA in seconds
 */
export function calculateETA(
  progressRatio: number,
  lineString: any,
  averageSpeed: number
): number {
  const totalDistance = calculateRouteDistance(lineString);
  const remainingDistance = totalDistance * (1 - progressRatio);
  return (remainingDistance / averageSpeed) * 3600; // seconds
}

/**
 * Interpolate truck position along route based on progress ratio
 */
export function interpolatePosition(
  lineString: any,
  progressRatio: number
): [number, number] {
  const coords = (lineString.coordinates || []) as [number, number][];
  
  if (coords.length === 0) {
    return [0, 0];
  }
  
  const totalDist = calculateRouteDistance(lineString);
  const targetDist = totalDist * progressRatio;
  
  let currentDist = 0;
  
  for (let i = 0; i < coords.length - 1; i++) {
    const coord1 = coords[i];
    const coord2 = coords[i + 1];
    
    if (!coord1 || !coord2) continue;
    
    const lng1 = coord1[0];
    const lat1 = coord1[1];
    const lng2 = coord2[0];
    const lat2 = coord2[1];
    
    const segmentDist = haversineDistance(lat1, lng1, lat2, lng2);
    
    if (currentDist + segmentDist >= targetDist) {
      const ratio = (targetDist - currentDist) / segmentDist;
      return [
        lng1 + (lng2 - lng1) * ratio,
        lat1 + (lat2 - lat1) * ratio
      ];
    }
    
    currentDist += segmentDist;
  }
  
  const lastCoord = coords[coords.length - 1];
  return lastCoord ? lastCoord : [0, 0];
}

/**
 * Haversine formula: calculate distance between two lat/lng points
 */
function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Format seconds to HH:MM:SS
 */
export function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}