import { calculateRouteDistance, interpolatePosition, calculateETA } from './etaService';
import { corridors } from './tdas';

// ===== TYPES =====
export interface ConcreteTruck {
  truckId: string;
  truckNumber: number;         // 1-based display number
  routeId: number;
  status: 'en-route' | 'arrived' | 'waiting';
  currentPosition: [number, number];  // [lng, lat]
  progressRatio: number;       // 0 → 1
  departureTime: Date;         // when truck left the plant
  arrivalTime: Date | null;    // actual arrival (null if still moving)
  estimatedArrival: Date;      // predicted arrival based on current speed
  elapsedSeconds: number;
  totalDistance: number;        // km
  currentSpeed: number;        // km/h (from TDAS or default)
  concreteVolume: number;      // m³ per truck
  isLate: boolean;             // arrived later than planned interval
}

export interface DeliveryRecord {
  truckId: string;
  truckNumber: number;
  routeId: number;
  departureTime: Date;
  arrivalTime: Date;
  plannedArrival: Date;
  travelTimeSeconds: number;
  concreteVolume: number;
  wasLate: boolean;
  cumulativeVolume: number;
}

export interface DeliveryConfig {
  routeId: number;
  targetVolume: number;        // m³ total target for the pour
  volumePerTruck: number;      // m³ per truck (default 8)
  trucksPerHour: number;       // dispatch frequency (default 12)
  startTime: Date;             // when first truck departs
  defaultSpeed: number;        // km/h fallback if no TDAS
}

// ===== STATE =====
let config: DeliveryConfig | null = null;
let activeTrucks: Map<string, ConcreteTruck> = new Map();
let deliveryLog: DeliveryRecord[] = [];
let nextTruckNumber = 1;
let nextDispatchTime: Date | null = null;
let routeGeometry: any = null;
let isRunning = false;

// ===== INIT =====
export function startDeliverySession(
  sessionConfig: DeliveryConfig,
  geometry: any
): { message: string; totalTrucksNeeded: number; intervalMinutes: number } {
  // Reset
  activeTrucks.clear();
  deliveryLog = [];
  nextTruckNumber = 1;
  isRunning = true;

  config = sessionConfig;
  routeGeometry = geometry;

  const intervalMinutes = 60 / config.trucksPerHour;
  const totalTrucksNeeded = Math.ceil(config.targetVolume / config.volumePerTruck);

  // Schedule first dispatch immediately
  nextDispatchTime = new Date(config.startTime);

  // Dispatch the first truck right away
  dispatchTruck();

  return {
    message: `Delivery started: ${totalTrucksNeeded} trucks needed, 1 every ${intervalMinutes} min`,
    totalTrucksNeeded,
    intervalMinutes
  };
}

// ===== DISPATCH =====
function dispatchTruck(): ConcreteTruck | null {
  if (!config || !routeGeometry || !isRunning) return null;

  // Check if we've already dispatched enough trucks
  const totalNeeded = Math.ceil(config.targetVolume / config.volumePerTruck);
  const totalDispatched = nextTruckNumber - 1;
  if (totalDispatched >= totalNeeded) return null;

  const totalDist = calculateRouteDistance(routeGeometry);
  const now = new Date();

  // Get current speed from TDAS for this route, fallback to config default
  const tdasData = corridors[config.routeId];
  const currentSpeed = (tdasData?.speed && tdasData.speed > 0)
    ? tdasData.speed
    : config.defaultSpeed;

  const travelTimeSeconds = (totalDist / currentSpeed) * 3600;
  const estimatedArrival = new Date(now.getTime() + travelTimeSeconds * 1000);

  // Starting position = first coordinate of the route
  const coords = routeGeometry.coordinates || [];
  const startPos: [number, number] = coords.length > 0
    ? [coords[0][0], coords[0][1]]
    : [0, 0];

  const truckId = `CMX-${String(nextTruckNumber).padStart(3, '0')}`;
  const truck: ConcreteTruck = {
    truckId,
    truckNumber: nextTruckNumber,
    routeId: config.routeId,
    status: 'en-route',
    currentPosition: startPos,
    progressRatio: 0,
    departureTime: now,
    arrivalTime: null,
    estimatedArrival,
    elapsedSeconds: 0,
    totalDistance: totalDist,
    currentSpeed,
    concreteVolume: config.volumePerTruck,
    isLate: false
  };

  activeTrucks.set(truckId, truck);
  nextTruckNumber++;

  // Schedule next dispatch
  const intervalMs = (60 / config.trucksPerHour) * 60 * 1000;
  nextDispatchTime = new Date(now.getTime() + intervalMs);

  console.log(`🚛 Dispatched ${truckId} | Speed: ${currentSpeed.toFixed(1)} km/h | ETA: ${travelTimeSeconds.toFixed(0)}s`);
  return truck;
}

// ===== TICK (called every second) =====
export function tickDelivery(dtSeconds: number): void {
  if (!config || !routeGeometry || !isRunning) return;

  const now = new Date();

  // Check if it's time to dispatch the next truck
  if (nextDispatchTime && now >= nextDispatchTime) {
    dispatchTruck();
  }

  // Update all en-route trucks
  for (const [truckId, truck] of activeTrucks.entries()) {
    if (truck.status !== 'en-route') continue;

    truck.elapsedSeconds += dtSeconds;

    // Get live TDAS speed (updates every 60s from backend)
    const tdasData = corridors[config.routeId];
    const liveSpeed = (tdasData?.speed && tdasData.speed > 0)
      ? tdasData.speed
      : config.defaultSpeed;
    truck.currentSpeed = liveSpeed;

    // Calculate progress based on distance covered
    const distCovered = (liveSpeed * truck.elapsedSeconds) / 3600; // km
    truck.progressRatio = Math.min(distCovered / truck.totalDistance, 1);

    // Interpolate position along route
    truck.currentPosition = interpolatePosition(routeGeometry, truck.progressRatio);

    // Recalculate ETA
    const remainingDist = truck.totalDistance * (1 - truck.progressRatio);
    const remainingSeconds = (remainingDist / liveSpeed) * 3600;
    truck.estimatedArrival = new Date(now.getTime() + remainingSeconds * 1000);

    // Check arrival
    if (truck.progressRatio >= 1) {
      completeTruck(truckId, now);
    }
  }
}

function completeTruck(truckId: string, now: Date): void {
  const truck = activeTrucks.get(truckId);
  if (!truck || !config) return;

  truck.status = 'arrived';
  truck.arrivalTime = now;
  truck.progressRatio = 1;

  // Was this truck late? Compare to planned interval
  const plannedIntervalMs = (60 / config.trucksPerHour) * 60 * 1000;
  const plannedArrival = new Date(
    config.startTime.getTime() +
    (truck.truckNumber - 1) * plannedIntervalMs +
    getBaselineTravelTime() * 1000
  );

  truck.isLate = now > plannedArrival;

  const cumulativeVol = deliveryLog.reduce((s, r) => s + r.concreteVolume, 0) + truck.concreteVolume;

  deliveryLog.push({
    truckId,
    truckNumber: truck.truckNumber,
    routeId: truck.routeId,
    departureTime: truck.departureTime,
    arrivalTime: now,
    plannedArrival,
    travelTimeSeconds: truck.elapsedSeconds,
    concreteVolume: truck.concreteVolume,
    wasLate: truck.isLate,
    cumulativeVolume: cumulativeVol
  });

  console.log(`✅ ${truckId} arrived | ${truck.elapsedSeconds.toFixed(0)}s | Late: ${truck.isLate} | Cumulative: ${cumulativeVol}m³`);
}

function getBaselineTravelTime(): number {
  if (!config || !routeGeometry) return 1800; // 30 min default
  const dist = calculateRouteDistance(routeGeometry);
  return (dist / config.defaultSpeed) * 3600;
}

// ===== QUERIES =====
export function getDeliveryStatus() {
  if (!config) return null;

  const totalNeeded = Math.ceil(config.targetVolume / config.volumePerTruck);
  const delivered = deliveryLog.reduce((s, r) => s + r.concreteVolume, 0);
  const remaining = Math.max(0, config.targetVolume - delivered);
  const trucksCompleted = deliveryLog.length;
  const trucksEnRoute = Array.from(activeTrucks.values()).filter(t => t.status === 'en-route').length;
  const trucksWaiting = totalNeeded - (trucksCompleted + trucksEnRoute);
  const lateTrucks = deliveryLog.filter(r => r.wasLate).length;

  // Delay estimate: if recent trucks are late, project when we'll finish
  let estimatedCompletionTime: Date | null = null;
  let delayMinutes = 0;

  if (trucksCompleted > 0) {
    const avgTravelTime = deliveryLog.reduce((s, r) => s + r.travelTimeSeconds, 0) / trucksCompleted;
    const intervalSeconds = (60 / config.trucksPerHour) * 60;
    const trucksRemaining = totalNeeded - trucksCompleted;
    // Time until all remaining dispatched + travel
    const remainingDispatchTime = Math.max(0, (trucksRemaining - trucksEnRoute)) * intervalSeconds;
    const lastTruckTravelTime = avgTravelTime;
    const totalRemainingSeconds = remainingDispatchTime + lastTruckTravelTime;
    estimatedCompletionTime = new Date(Date.now() + totalRemainingSeconds * 1000);

    // Planned completion
    const plannedTotalSeconds = (totalNeeded - 1) * intervalSeconds + getBaselineTravelTime();
    const plannedCompletion = new Date(config.startTime.getTime() + plannedTotalSeconds * 1000);
    delayMinutes = Math.max(0, Math.round((estimatedCompletionTime.getTime() - plannedCompletion.getTime()) / 60000));
  }

  return {
    config: {
      targetVolume: config.targetVolume,
      volumePerTruck: config.volumePerTruck,
      trucksPerHour: config.trucksPerHour,
      routeId: config.routeId,
      startTime: config.startTime.toISOString()
    },
    progress: {
      delivered,
      remaining,
      percentComplete: config.targetVolume > 0 ? Math.round((delivered / config.targetVolume) * 100) : 0,
      totalTrucksNeeded: totalNeeded,
      trucksCompleted,
      trucksEnRoute,
      trucksWaiting: Math.max(0, trucksWaiting),
      lateTrucks,
      delayMinutes,
      estimatedCompletion: estimatedCompletionTime?.toISOString() || null
    },
    trucks: Array.from(activeTrucks.values()).map(t => ({
      truckId: t.truckId,
      truckNumber: t.truckNumber,
      status: t.status,
      position: t.currentPosition,
      progress: Math.round(t.progressRatio * 100),
      currentSpeed: Math.round(t.currentSpeed),
      departureTime: t.departureTime.toISOString(),
      estimatedArrival: t.estimatedArrival.toISOString(),
      arrivalTime: t.arrivalTime?.toISOString() || null,
      concreteVolume: t.concreteVolume,
      isLate: t.isLate,
      elapsedSeconds: Math.round(t.elapsedSeconds)
    })),
    deliveryLog: deliveryLog.map(r => ({
      truckId: r.truckId,
      truckNumber: r.truckNumber,
      departureTime: r.departureTime.toISOString(),
      arrivalTime: r.arrivalTime.toISOString(),
      travelTimeMinutes: Math.round(r.travelTimeSeconds / 60),
      concreteVolume: r.concreteVolume,
      wasLate: r.wasLate,
      cumulativeVolume: r.cumulativeVolume
    })),
    timestamp: new Date().toISOString()
  };
}

export function stopDelivery(): void {
  isRunning = false;
  console.log('🛑 Delivery session stopped');
}

export function resetDelivery(): void {
  activeTrucks.clear();
  deliveryLog = [];
  nextTruckNumber = 1;
  nextDispatchTime = null;
  config = null;
  routeGeometry = null;
  isRunning = false;
  console.log('🔄 Delivery session reset');
}

export function isDeliveryRunning(): boolean {
  return isRunning;
}

// Re-export for backward compat
export function getTrucks(): ConcreteTruck[] {
  return Array.from(activeTrucks.values());
}
export function getTotalConcreteDelivered(): number {
  return deliveryLog.reduce((s, r) => s + r.concreteVolume, 0);
}
export function getActiveCount(): number {
  return Array.from(activeTrucks.values()).filter(t => t.status === 'en-route').length;
}
export function getCompletedCount(): number {
  return deliveryLog.length;
}
export function getDeliveryRecords(): DeliveryRecord[] {
  return deliveryLog;
}