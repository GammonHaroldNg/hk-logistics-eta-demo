import { calculateRouteDistance, interpolatePosition } from './etaService';
import { corridors } from './tdas';

// ===== TYPES =====
export interface ConcreteTruck {
  truckId: string;
  truckNumber: number;
  routeId: number;
  status: 'en-route' | 'arrived' | 'waiting';
  currentPosition: [number, number];
  progressRatio: number;
  departureTime: Date;
  arrivalTime: Date | null;
  estimatedArrival: Date;
  elapsedSeconds: number;
  totalDistance: number;
  currentSpeed: number;
  concreteVolume: number;
  isLate: boolean;
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
  routeId: number;           // 0 = all project routes combined
  targetVolume: number;
  volumePerTruck: number;
  trucksPerHour: number;
  startTime: Date;
  defaultSpeed: number;
}

// ===== STATE =====
let config: DeliveryConfig | null = null;
let activeTrucks: Map<string, ConcreteTruck> = new Map();
let deliveryLog: DeliveryRecord[] = [];
let nextTruckNumber = 1;
let nextDispatchTime: Date | null = null;
let routeGeometry: any = null;
let corridorSegmentCount = 0;
let isRunning = false;

// ===== AVERAGE SPEED ACROSS ALL PROJECT ROUTES =====
function getAverageProjectSpeed(defaultSpeed: number): number {
  const MIXER_MAX_SPEED = 60; // loaded concrete truck practical cap in HK
  let totalSpeed = 0;
  let count = 0;
  for (const routeIdStr of Object.keys(corridors)) {
    const data = corridors[Number(routeIdStr)];
    if (data && data.speed && data.speed > 0) {
      totalSpeed += Math.min(data.speed, MIXER_MAX_SPEED); // cap each segment
      count++;
    }
  }
  return count > 0 ? totalSpeed / count : defaultSpeed;
}


// ===== INIT =====
export function startDeliverySession(
  sessionConfig: DeliveryConfig,
  geometry: any,
  segmentCount: number = 1
): { message: string; totalTrucksNeeded: number; intervalMinutes: number; totalDistance: string; segmentCount: number } {
  activeTrucks.clear();
  deliveryLog = [];
  nextTruckNumber = 1;
  isRunning = true;

  config = sessionConfig;
  routeGeometry = geometry;
  corridorSegmentCount = segmentCount;

  const intervalMinutes = 60 / config.trucksPerHour;
  const totalTrucksNeeded = Math.ceil(config.targetVolume / config.volumePerTruck);
  const totalDist = calculateRouteDistance(geometry);

  nextDispatchTime = new Date(config.startTime);
  dispatchTruck();

  return {
    message: `Delivery started: ${totalTrucksNeeded} trucks needed, 1 every ${intervalMinutes} min, ${totalDist.toFixed(1)} km corridor`,
    totalTrucksNeeded,
    intervalMinutes,
    totalDistance: totalDist.toFixed(1),
    segmentCount
  };
}

// ===== DISPATCH =====
function dispatchTruck(): ConcreteTruck | null {
  if (!config || !routeGeometry || !isRunning) return null;

  const totalNeeded = Math.ceil(config.targetVolume / config.volumePerTruck);
  const totalDispatched = nextTruckNumber - 1;
  if (totalDispatched >= totalNeeded) return null;

  const totalDist = calculateRouteDistance(routeGeometry);
  const now = new Date();
  const currentSpeed = getAverageProjectSpeed(config.defaultSpeed);
  const travelTimeSeconds = (totalDist / currentSpeed) * 3600;
  const estimatedArrival = new Date(now.getTime() + travelTimeSeconds * 1000);

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

  const intervalMs = (60 / config.trucksPerHour) * 60 * 1000;
  nextDispatchTime = new Date(now.getTime() + intervalMs);

  console.log(`🚛 Dispatched ${truckId} | Speed: ${currentSpeed.toFixed(1)} km/h | ETA: ${travelTimeSeconds.toFixed(0)}s | Dist: ${totalDist.toFixed(1)}km`);
  return truck;
}

// ===== TICK =====
export function tickDelivery(dtSeconds: number): void {
  if (!config || !routeGeometry || !isRunning) return;

  const now = new Date();

  if (nextDispatchTime && now >= nextDispatchTime) {
    dispatchTruck();
  }

  for (const [truckId, truck] of activeTrucks.entries()) {
    if (truck.status !== 'en-route') continue;

    truck.elapsedSeconds += dtSeconds;

    const liveSpeed = getAverageProjectSpeed(config.defaultSpeed);
    truck.currentSpeed = liveSpeed;

    const distCovered = (liveSpeed * truck.elapsedSeconds) / 3600;
    truck.progressRatio = Math.min(distCovered / truck.totalDistance, 1);
    truck.currentPosition = interpolatePosition(routeGeometry, truck.progressRatio);

    const remainingDist = truck.totalDistance * (1 - truck.progressRatio);
    const remainingSeconds = (remainingDist / liveSpeed) * 3600;
    truck.estimatedArrival = new Date(now.getTime() + remainingSeconds * 1000);

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
  if (!config || !routeGeometry) return 1800;
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
  const trucksWaiting = Math.max(0, totalNeeded - (trucksCompleted + trucksEnRoute));
  const lateTrucks = deliveryLog.filter(r => r.wasLate).length;

  let estimatedCompletionTime: Date | null = null;
  let delayMinutes = 0;

  if (trucksCompleted > 0) {
    const avgTravelTime = deliveryLog.reduce((s, r) => s + r.travelTimeSeconds, 0) / trucksCompleted;
    const intervalSeconds = (60 / config.trucksPerHour) * 60;
    const trucksRemaining = totalNeeded - trucksCompleted;
    const remainingDispatchTime = Math.max(0, (trucksRemaining - trucksEnRoute)) * intervalSeconds;
    const lastTruckTravelTime = avgTravelTime;
    const totalRemainingSeconds = remainingDispatchTime + lastTruckTravelTime;
    estimatedCompletionTime = new Date(Date.now() + totalRemainingSeconds * 1000);

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
      startTime: config.startTime.toISOString(),
      totalSegments: corridorSegmentCount,
      totalDistance: routeGeometry ? calculateRouteDistance(routeGeometry).toFixed(1) : '0'
    },
    progress: {
      delivered,
      remaining,
      percentComplete: config.targetVolume > 0 ? Math.round((delivered / config.targetVolume) * 100) : 0,
      totalTrucksNeeded: totalNeeded,
      trucksCompleted,
      trucksEnRoute,
      trucksWaiting,
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
  corridorSegmentCount = 0;
  isRunning = false;
  console.log('🔄 Delivery session reset');
}

export function isDeliveryRunning(): boolean {
  return isRunning;
}

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