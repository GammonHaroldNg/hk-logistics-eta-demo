import { corridors } from './tdas';

export type TruckStatus = 'DRIVING' | 'DONE';

export interface Truck {
  id: string;
  corridorId: number;  // Changed from string to number
  distanceTotal: number;
  distanceDone: number;
  speedMps: number;
  status: TruckStatus;
  eta?: Date;
}

export const trucks: Truck[] = [
  {
    id: 'TRUCK-1',
    corridorId: 93147,  // Changed from 'ROUTE_001' to numeric ID
    distanceTotal: 10000,
    distanceDone: 0,
    speedMps: 10,
    status: 'DRIVING'
  }
];

export function tickSimulation(dtSec: number) {
  const now = new Date();

  for (const truck of trucks) {
    if (truck.status !== 'DRIVING') continue;

    const corridor = corridors[truck.corridorId];
    
    // Use a default speed if corridor not found
    const defaultSpeed = 5.56; // ~10000m in 30min
    truck.speedMps = corridor ? (truck.distanceTotal / 1800) : defaultSpeed;

    // Move truck forward
    truck.distanceDone += truck.speedMps * dtSec;

    // Check if journey is complete
    if (truck.distanceDone >= truck.distanceTotal) {
      truck.distanceDone = truck.distanceTotal;
      truck.status = 'DONE';
    }

    // Calculate remaining distance and time, then set ETA
    const remainingDist = truck.distanceTotal - truck.distanceDone;
    const remainingTimeSec = remainingDist / truck.speedMps;
    truck.eta = new Date(now.getTime() + remainingTimeSec * 1000);
  }
}
