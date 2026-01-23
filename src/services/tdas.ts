export type TrafficState = 'GREEN' | 'YELLOW' | 'RED';

export interface Corridor {
  id: number;
  state: TrafficState;
  speed: number;
  lastUpdated: Date;
}

export const corridors: Record<number, Corridor> = {};

// Create or update for ANY ID we see from traffic feed
export function updateCorridorState(
  routeId: number,
  state: TrafficState,
  speed: number
) {
  if (!corridors[routeId]) {
    corridors[routeId] = {
      id: routeId,
      state,
      speed,
      lastUpdated: new Date()
    };
  } else {
    corridors[routeId].state = state;
    corridors[routeId].speed = speed;
    corridors[routeId].lastUpdated = new Date();
  }
}