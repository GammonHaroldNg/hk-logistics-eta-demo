// API endpoints
export const API_ENDPOINTS = {
  TRAFFIC: 'http://localhost:3000/api/traffic-speeds',
  CORRIDORS: 'http://localhost:3000/api/corridors',
  TRUCKS: 'http://localhost:3000/api/trucks',
};

// Update intervals (milliseconds)
export const UPDATE_INTERVALS = {
  OVERVIEW: 5 * 60 * 1000,  // 5 minutes
  TRACKING: 30 * 1000,      // 30 seconds
};

// Traffic states
export const TRAFFIC_STATES = {
  GREEN: { color: '#22c55e', label: 'Smooth' },
  YELLOW: { color: '#eab308', label: 'Slow' },
  RED: { color: '#ef4444', label: 'Congested' },
};

// Map defaults
export const MAP_CONFIG = {
  CENTER: [114.1738, 22.3193],  // Hong Kong center
  ZOOM: 11,
  STYLE: 'https://demotiles.maplibre.org/style.json',
};