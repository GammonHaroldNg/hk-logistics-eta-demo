import { calculateRouteDistance, interpolatePosition } from './etaService';

export interface ConcreteTruck {
  truckId: string;
  routeId: number;
  status: 'moving' | 'completed' | 'waiting';
  currentPosition: [number, number];
  progressRatio: number;
  elapsedTime: number;
  totalDistance: number;
  averageSpeed: number;
  eta: number;
  completedAt?: Date;
  concreteLoad: number;
}

export interface DeliveryRecord {
  truckId: string;
  routeId: number;
  startTime: Date;
  completionTime: Date;
  totalTime: number;
  concreteDelivered: number;
}

const trucks: Map<string, ConcreteTruck> = new Map();
const deliveryRecords: DeliveryRecord[] = [];

const CONCRETE_LOAD = 10;
const AVERAGE_SPEED = 40;

export function initializeTrucks(
  routeId: number,
  geometry: any,
  count: number = 5
): void {
  trucks.clear();
  
  const coords = (geometry.coordinates || []) as [number, number][];
  
  // Safe extraction of startCoord with type assertion
  let startCoord: [number, number] = [0, 0];
  if (coords.length > 0) {
    startCoord = coords[0] as [number, number];
  }
  
  const totalDist = calculateRouteDistance(geometry);
  
  for (let i = 0; i < count; i++) {
    const truckId = `truck-${routeId}-${i}-${Date.now()}`;
    const totalTimeSeconds = (totalDist / AVERAGE_SPEED) * 3600;
    
    trucks.set(truckId, {
      truckId,
      routeId,
      status: 'moving',
      currentPosition: startCoord,
      progressRatio: 0,
      elapsedTime: 0,
      totalDistance: totalDist,
      averageSpeed: AVERAGE_SPEED,
      eta: totalTimeSeconds,
      concreteLoad: CONCRETE_LOAD
    });
  }
  
  console.log(`✓ Initialized ${count} trucks for route ${routeId}`);
}

export function updateTruckProgress(
  deltaTimeSeconds: number,
  geometry: any
): void {
  for (const [truckId, truck] of trucks.entries()) {
    if (truck.status !== 'moving') continue;
    
    truck.elapsedTime += deltaTimeSeconds;
    
    const totalTimeSeconds = (truck.totalDistance / truck.averageSpeed) * 3600;
    truck.progressRatio = Math.min(truck.elapsedTime / totalTimeSeconds, 1);
    
    truck.currentPosition = interpolatePosition(geometry, truck.progressRatio);
    
    truck.eta = Math.max(0, totalTimeSeconds - truck.elapsedTime);
    
    if (truck.progressRatio >= 1) {
      completeTruck(truckId);
    }
  }
}

function completeTruck(truckId: string): void {
  const truck = trucks.get(truckId);
  if (!truck) return;
  
  truck.status = 'completed';
  truck.completedAt = new Date();
  truck.progressRatio = 1;
  
  deliveryRecords.push({
    truckId,
    routeId: truck.routeId,
    startTime: new Date(Date.now() - truck.elapsedTime * 1000),
    completionTime: new Date(),
    totalTime: truck.elapsedTime,
    concreteDelivered: truck.concreteLoad
  });
  
  console.log(`✓ Truck ${truckId} completed. Total delivered: ${getTotalConcreteDelivered()}`);
}

export function getTrucks(): ConcreteTruck[] {
  return Array.from(trucks.values());
}

export function getDeliveryRecords(): DeliveryRecord[] {
  return deliveryRecords;
}

export function getTotalConcreteDelivered(): number {
  return deliveryRecords.reduce((sum, r) => sum + r.concreteDelivered, 0);
}

export function resetSimulation(): void {
  trucks.clear();
  deliveryRecords.length = 0;
  console.log('✓ Simulation reset');
}

export function getActiveCount(): number {
  return Array.from(trucks.values()).filter(t => t.status === 'moving').length;
}

export function getCompletedCount(): number {
  return Array.from(trucks.values()).filter(t => t.status === 'completed').length;
}
