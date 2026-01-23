export interface TrafficSegment {
  segmentId: number;
  speed: number;
  valid: boolean;
  captureDate?: string;
  captureTime?: string;
}

export type TrafficState = 'RED' | 'YELLOW' | 'GREEN';

export interface TrafficResponse {
  timestamp: string;
  segments: Map<number, TrafficSegment>;
  stateMap: Map<number, TrafficState>;
}