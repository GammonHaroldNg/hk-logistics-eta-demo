import xml2js from 'xml2js';

// ===== TYPES (inline) =====
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

// ===== SERVICE FUNCTIONS =====
export async function fetchTrafficSpeedMap(): Promise<Map<number, TrafficSegment>> {
  const url = 'https://resource.data.one.gov.hk/td/traffic-detectors/irnAvgSpeed-all.xml';

  try {
    console.log('Fetching traffic data from:', url);
    const response = await fetch(url);

    if (!response.ok) {
      console.error('HTTP error:', response.status, response.statusText);
      return new Map();
    }

    const xmlText = await response.text();
    const parser = new xml2js.Parser({ mergeAttrs: true });
    const result = await parser.parseStringPromise(xmlText);

    const speedMap = new Map<number, TrafficSegment>();

    // Debug: log the actual structure
    console.log('Root keys:', Object.keys(result));
    
    const rootKey = Object.keys(result)[0] as string;
    const root = result[rootKey as keyof typeof result];

    
    let captureDate = undefined;
    let captureTime = undefined;
    let segments: any[] = [];

    // Find capture date/time and segments
    if (root) {
      captureDate = root.date?.[0];
      captureTime = root.time?.[0];
      
      // The segments might be directly in root or nested
      segments = root.segment || root.segments?.[0]?.segment || [];
    }

    console.log('Traffic data captured at:', captureDate, captureTime);
    console.log('Found', segments.length, 'traffic segments');

    if (!segments || segments.length === 0) {
      console.warn('No segments found in XML - using default traffic');
      return new Map();
    }

    let validCount = 0;
    let totalCount = 0;
    for (const segment of segments) {
      const segmentId = parseInt(segment.segmentid?.[0] || segment.segment_id?.[0] || '0', 10);
      const speed = parseFloat(segment.speed?.[0] || '0');
      const valid = segment.valid?.[0] === 'Y';

      if (segmentId > 0 && speed >= 0) {
        speedMap.set(segmentId, { segmentId, speed, valid, captureDate, captureTime });
        totalCount++;
        if (valid) validCount++;
      }
    }

    console.log(`✓ Fetched traffic data for ${totalCount} segments (${validCount} valid=Y)`);

    // Show first 5 segments as sample
    let count = 0;
    for (const [segmentId, data] of speedMap.entries()) {
      if (count >= 5) break;
      console.log(` Segment ${segmentId}: ${data.speed.toFixed(1)} km/h`);
      count++;
    }

    return speedMap;
  } catch (err: any) {
    console.error('Error fetching traffic speed map:', err.message);
    return new Map();
  }
}

export function speedToState(speed: number): TrafficState {
  if (speed < 30) return 'RED';
  if (speed < 50) return 'YELLOW';
  return 'GREEN';
}

export function createTrafficResponse(segments: Map<number, TrafficSegment>): TrafficResponse {
  const stateMap = new Map<number, TrafficState>();

  for (const [id, segment] of segments) {
    stateMap.set(id, speedToState(segment.speed));
  }

  return {
    timestamp: new Date().toISOString(),
    segments,
    stateMap,
  };
}