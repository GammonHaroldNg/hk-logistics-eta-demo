import { calculateRouteDistance, interpolatePosition } from './etaService';
import { corridors } from './tdas';
import { getAllCorridors } from './corridorService';
import { PROJECT_ROUTE_IDS } from '../constants/projectRoutes';


// ===== CONSTANTS =====
const MIXER_MAX_SPEED = 60; // km/h — loaded concrete truck cap in HK

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
}

export interface DeliveryRecord {
  truckId: string;
  truckNumber: number;
  routeId: number;
  departureTime: Date;
  arrivalTime: Date;
  travelTimeSeconds: number;
  concreteVolume: number;
  cumulativeVolume: number;
  hourWindow: number; // which hour window (0-based)
}

export interface DeliveryConfig {
  routeId: number;
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
const tripToTruckId: Map<string, string> = new Map();
const AUTO_DISPATCH_ENABLED = false;

// ===== SPEED: average TDAS capped at mixer max =====
function getAverageProjectSpeed(defaultSpeed: number): number {
  const allCorridors = getAllCorridors();
  let totalWeightedSpeed = 0;
  let totalDistance = 0;

  for (const routeId of PROJECT_ROUTE_IDS) {
    const tdasData = corridors[routeId];
    const corridor: any = allCorridors[routeId];

    if (!corridor || !corridor.geometry) continue;

    const segDist = calculateRouteDistance(corridor.geometry);
    if (segDist <= 0) continue;

    const speed = (tdasData && tdasData.speed > 0)
      ? Math.min(tdasData.speed, MIXER_MAX_SPEED)
      : Math.min(defaultSpeed, MIXER_MAX_SPEED);

    totalWeightedSpeed += speed * segDist;
    totalDistance += segDist;
  }

  if (totalDistance <= 0) return Math.min(defaultSpeed, MIXER_MAX_SPEED);
  return totalWeightedSpeed / totalDistance;
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
    message: 'Delivery started: ' + totalTrucksNeeded + ' trucks needed, 1 every ' + intervalMinutes + ' min, ' + totalDist.toFixed(1) + ' km corridor',
    totalTrucksNeeded,
    intervalMinutes,
    totalDistance: totalDist.toFixed(1),
    segmentCount
  };
}

// ===== DISPATCH =====
function dispatchTruck(): ConcreteTruck | null {
  if (!AUTO_DISPATCH_ENABLED) return null;        // new line

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
    ? [coords[0]![0]!, coords[0]![1]!]
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
  };

  activeTrucks.set(truckId, truck);
  nextTruckNumber++;

  const intervalMs = (60 / config.trucksPerHour) * 60 * 1000;
  nextDispatchTime = new Date(now.getTime() + intervalMs);

  console.log(
    'Dispatched ' + truckId +
      ' | Speed: ' + currentSpeed.toFixed(1) +
      ' km/h | ETA: ' + Math.round(travelTimeSeconds) + 's'
  );
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
    const newProgress = Math.min(distCovered / truck.totalDistance, 1);
    truck.progressRatio = Math.max(truck.progressRatio, newProgress); // monotonic
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

  // Determine which hour window this arrival falls in
  const elapsedMs = now.getTime() - config.startTime.getTime();
  const hourWindow = Math.floor(elapsedMs / 3600000);

  const cumulativeVol = deliveryLog.reduce((s, r) => s + r.concreteVolume, 0) + truck.concreteVolume;

  deliveryLog.push({
    truckId,
    truckNumber: truck.truckNumber,
    routeId: truck.routeId,
    departureTime: truck.departureTime,
    arrivalTime: now,
    travelTimeSeconds: truck.elapsedSeconds,
    concreteVolume: truck.concreteVolume,
    cumulativeVolume: cumulativeVol,
    hourWindow
  });

  console.log('Arrived ' + truckId + ' | ' + Math.round(truck.elapsedSeconds) + 's | Window ' + hourWindow + ' | Cumulative: ' + cumulativeVol + 'm3');
}

function getBaselineTravelTime(): number {
  if (!config || !routeGeometry) return 1800;
  const dist = calculateRouteDistance(routeGeometry);
  return (dist / Math.min(config.defaultSpeed, MIXER_MAX_SPEED)) * 3600;
}

// ===== THROUGHPUT ANALYSIS =====
function getThroughputAnalysis(): {
  currentWindow: number;
  windowTarget: number;
  windowActual: number;
  windowShortfall: number;
  hourlyBreakdown: Array<{ hour: number; target: number; actual: number; diff: number }>;
  actualRate: number;
  behindSchedule: boolean;
  delayMinutes: number;
} {
  if (!config) {
    return {
      currentWindow: 0, windowTarget: 0, windowActual: 0, windowShortfall: 0,
      hourlyBreakdown: [], actualRate: 0, behindSchedule: false, delayMinutes: 0
    };
  }

  const now = new Date();
  const elapsedMs = now.getTime() - config.startTime.getTime();
  const elapsedHours = elapsedMs / 3600000;
  const currentWindow = Math.floor(elapsedHours);
  const fractionIntoCurrentHour = elapsedHours - currentWindow;

  // How many trucks SHOULD have arrived by now (pro-rated)
  const expectedByNow = Math.floor(elapsedHours * config.trucksPerHour);
  const actualTotal = deliveryLog.length;

  // Hourly breakdown
  const maxWindow = currentWindow + 1;
  const hourlyBreakdown: Array<{ hour: number; target: number; actual: number; diff: number }> = [];

  for (let h = 0; h < maxWindow; h++) {
    const arrivalsInWindow = deliveryLog.filter(r => r.hourWindow === h).length;
    const isCurrentHour = h === currentWindow;
    // For the current partial hour, pro-rate the target
    const target = isCurrentHour
      ? Math.floor(fractionIntoCurrentHour * config.trucksPerHour)
      : config.trucksPerHour;
    hourlyBreakdown.push({
      hour: h,
      target,
      actual: arrivalsInWindow,
      diff: arrivalsInWindow - target
    });
  }

  // Current window stats
  const currentWindowArrivals = deliveryLog.filter(r => r.hourWindow === currentWindow).length;
  const currentWindowTarget = Math.floor(fractionIntoCurrentHour * config.trucksPerHour);

  // Actual throughput rate (trucks per hour based on all completions)
  const actualRate = elapsedHours > 0 ? actualTotal / elapsedHours : 0;

  // Shortfall & delay
  const shortfall = Math.max(0, expectedByNow - actualTotal);
  const behindSchedule = shortfall > 0;

  // Project total completion time
  const totalNeeded = Math.ceil(config.targetVolume / config.volumePerTruck);
  let delayMinutes = 0;

  if (actualTotal > 0 && actualRate > 0) {
    const trucksRemaining = totalNeeded - actualTotal;
    const hoursToFinish = trucksRemaining / actualRate;
    const projectedFinish = new Date(now.getTime() + hoursToFinish * 3600000);

    // Planned finish: all trucks at target rate
    const plannedHoursTotal = totalNeeded / config.trucksPerHour;
    const plannedTravelSeconds = getBaselineTravelTime();
    const plannedFinish = new Date(config.startTime.getTime() + plannedHoursTotal * 3600000 + plannedTravelSeconds * 1000);

    delayMinutes = Math.max(0, Math.round((projectedFinish.getTime() - plannedFinish.getTime()) / 60000));
  }

  return {
    currentWindow,
    windowTarget: currentWindowTarget,
    windowActual: currentWindowArrivals,
    windowShortfall: Math.max(0, currentWindowTarget - currentWindowArrivals),
    hourlyBreakdown,
    actualRate: Math.round(actualRate * 10) / 10,
    behindSchedule,
    delayMinutes
  };
}

// ===== STATUS =====
export function getDeliveryStatus() {
  if (!config) return null;

  const totalNeeded = Math.ceil(config.targetVolume / config.volumePerTruck);
  const delivered = deliveryLog.reduce((s, r) => s + r.concreteVolume, 0);
  const trucksCompleted = deliveryLog.length;
  const trucksEnRoute = Array.from(activeTrucks.values()).filter(t => t.status === 'en-route').length;
  const trucksWaiting = Math.max(0, totalNeeded - (trucksCompleted + trucksEnRoute));

  const throughput = getThroughputAnalysis();

  // Estimated completion
  let estimatedCompletionTime: Date | null = null;
  if (throughput.actualRate > 0) {
    const trucksRemaining = totalNeeded - trucksCompleted;
    const hoursToFinish = trucksRemaining / throughput.actualRate;
    estimatedCompletionTime = new Date(Date.now() + hoursToFinish * 3600000);
  }

  return {
    config: {
      targetVolume: config.targetVolume,
      volumePerTruck: config.volumePerTruck,
      trucksPerHour: config.trucksPerHour,
      routeId: config.routeId,
      startTime: config.startTime.toISOString(),
      totalSegments: corridorSegmentCount,
      totalDistance: routeGeometry ? calculateRouteDistance(routeGeometry).toFixed(1) : '0',
      mixerSpeedCap: MIXER_MAX_SPEED
    },
    progress: {
      delivered,
      remaining: Math.max(0, config.targetVolume - delivered),
      percentComplete: config.targetVolume > 0 ? Math.round((delivered / config.targetVolume) * 100) : 0,
      totalTrucksNeeded: totalNeeded,
      trucksCompleted,
      trucksEnRoute,
      trucksWaiting,
      estimatedCompletion: estimatedCompletionTime ? estimatedCompletionTime.toISOString() : null
    },
    throughput: {
      targetRate: config.trucksPerHour,
      actualRate: throughput.actualRate,
      currentWindow: throughput.currentWindow,
      windowTarget: throughput.windowTarget,
      windowActual: throughput.windowActual,
      windowShortfall: throughput.windowShortfall,
      behindSchedule: throughput.behindSchedule,
      delayMinutes: throughput.delayMinutes,
      hourlyBreakdown: throughput.hourlyBreakdown
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
      arrivalTime: t.arrivalTime ? t.arrivalTime.toISOString() : null,
      concreteVolume: t.concreteVolume,
      elapsedSeconds: Math.round(t.elapsedSeconds)
    })),
    deliveryLog: deliveryLog.map(r => ({
      truckId: r.truckId,
      truckNumber: r.truckNumber,
      departureTime: r.departureTime.toISOString(),
      arrivalTime: r.arrivalTime.toISOString(),
      travelTimeMinutes: Math.round(r.travelTimeSeconds / 60),
      concreteVolume: r.concreteVolume,
      cumulativeVolume: r.cumulativeVolume,
      hourWindow: r.hourWindow
    })),
    timestamp: new Date().toISOString()
  };
}

export function stopDelivery(): void {
  isRunning = false;
  console.log('Delivery session stopped');
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
  console.log('Delivery session reset');
}

export interface DbTrip {
  id: string;
  vehicle_id: string;
  actual_start_at: string | null;
  actual_arrival_at: string | null;
  status: 'planned' | 'in_progress' | 'completed';
  corrected: boolean | null;
}

function ensureConfigForDb(): void {
  if (!config && routeGeometry) {
    // Minimal config so throughput computations still work
    config = {
      routeId: 0,
      targetVolume: 600,
      volumePerTruck: 8,
      trucksPerHour: 12,
      startTime: new Date(),        // will be used only for windows
      defaultSpeed: 40,
    };
    isRunning = true;
  }
}

export function addTruckFromTrip(trip: DbTrip, totalDist: number, speedKmh: number): ConcreteTruck | null {
  if (!routeGeometry) return null;
  if (!trip.actual_start_at) return null;

  ensureConfigForDb();

  const startTime = new Date(trip.actual_start_at);
  const now = new Date();

  const speed = Math.min(speedKmh, MIXER_MAX_SPEED);
  const travelTimeSeconds = (totalDist / speed) * 3600;

  const elapsedSeconds = Math.max(0, (now.getTime() - startTime.getTime()) / 1000);
  const progressRatio = Math.min(elapsedSeconds / travelTimeSeconds, 1);

  const existingId = tripToTruckId.get(trip.id);
  if (existingId && activeTrucks.has(existingId)) {
    const existing = activeTrucks.get(existingId);
    if (existing) {
      existing.progressRatio = Math.max(existing.progressRatio, progressRatio);
      existing.currentPosition =
        interpolatePosition(routeGeometry, existing.progressRatio) ?? existing.currentPosition;
      return existing;
    }
  }

  // If we had a mapping but no active truck (e.g. after reset), don’t re-create
  if (existingId && !activeTrucks.has(existingId)) {
    return null;
  }

  // NEW: define startPos for DB trucks as well
  const coords = routeGeometry.coordinates || [];
  const startPos: [number, number] = coords.length > 0
    ? [coords[0]![0]!, coords[0]![1]!]
    : [0, 0];

  const truckId = `TRIP-${trip.id}`;

  const truck: ConcreteTruck = {
    truckId,
    truckNumber: ++nextTruckNumber,
    routeId: config!.routeId,
    status: progressRatio >= 1 ? 'arrived' : 'en-route',
    currentPosition: interpolatePosition(routeGeometry, progressRatio) ?? startPos,
    progressRatio,
    departureTime: startTime,
    arrivalTime: progressRatio >= 1 ? now : null,
    estimatedArrival: new Date(startTime.getTime() + travelTimeSeconds * 1000),
    elapsedSeconds,
    totalDistance: totalDist,
    currentSpeed: speed,
    concreteVolume: config!.volumePerTruck,
  };

  activeTrucks.set(truckId, truck);
  tripToTruckId.set(trip.id, truckId);

  if (truck.status === 'arrived') {
    completeTruckFromDb(trip.id, now);
  }

  return truck;
}

export function completeTruckFromDb(tripId: string, arrivalTime: Date): void {
  const truckId = tripToTruckId.get(tripId);
  if (!truckId) return;

  const truck = activeTrucks.get(truckId);
  if (!truck || !config) return;

  truck.status = 'arrived';
  truck.arrivalTime = arrivalTime;
  truck.progressRatio = 1;

  const elapsedMs = arrivalTime.getTime() - config.startTime.getTime();
  const hourWindow = Math.max(0, Math.floor(elapsedMs / 3600000));
  const cumulativeVol = deliveryLog.reduce((s, r) => s + r.concreteVolume, 0) + truck.concreteVolume;

  deliveryLog.push({
    truckId: truck.truckId,
    truckNumber: truck.truckNumber,
    routeId: truck.routeId,
    departureTime: truck.departureTime,
    arrivalTime,
    travelTimeSeconds: truck.elapsedSeconds,
    concreteVolume: truck.concreteVolume,
    cumulativeVolume: cumulativeVol,
    hourWindow,
  });

  activeTrucks.delete(truckId);
  tripToTruckId.delete(tripId); // important
}


export async function hydrateFromTrips(trips: DbTrip[], defaultSpeedKmh: number): Promise<void> {
  if (!routeGeometry) return;
  ensureConfigForDb();

  const totalDist = calculateRouteDistance(routeGeometry);
  if (totalDist <= 0) return;

  for (const trip of trips) {
    if (trip.status !== 'in_progress') continue;
    addTruckFromTrip(trip, totalDist, defaultSpeedKmh);
  }
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

export function pruneInactiveTrips(activeTripIds: string[]): void {
  for (const [tripId, truckId] of tripToTruckId.entries()) {
    if (!activeTripIds.includes(tripId)) {
      const truck = activeTrucks.get(truckId);
      if (truck) {
        activeTrucks.delete(truckId);
      }
      tripToTruckId.delete(tripId);
    }
  }
}

export function clearActiveTrucks(): void {
  activeTrucks.clear();
  tripToTruckId.clear();
}