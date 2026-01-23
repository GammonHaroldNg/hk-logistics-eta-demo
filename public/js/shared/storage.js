/**
 * Cache Management for Smooth Transitions
 * Prevents white screen when navigating between pages
 */

export const DataCache = {
  // Keys
  KEYS: {
    TRAFFIC_DATA: 'hk_traffic_data',
    MAP_STATE: 'hk_map_state',
    ROUTE_CONFIG: 'hk_route_config',
    CORRIDORS: 'hk_corridors',
    TRUCKS: 'hk_trucks',
  },

  // Traffic data
  saveTrafficData(data) {
    try {
      sessionStorage.setItem(this.KEYS.TRAFFIC_DATA, JSON.stringify({
        data,
        timestamp: Date.now(),
      }));
    } catch (e) {
      console.warn('Failed to cache traffic data:', e);
    }
  },

  getTrafficData() {
    try {
      const cached = sessionStorage.getItem(this.KEYS.TRAFFIC_DATA);
      if (!cached) return null;
      const { data, timestamp } = JSON.parse(cached);
      // Use cache if less than 2 minutes old
      if (Date.now() - timestamp < 2 * 60 * 1000) {
        return data;
      }
      return null;
    } catch (e) {
      return null;
    }
  },

  // Map state (center, zoom)
  saveMapState(center, zoom) {
    try {
      sessionStorage.setItem(this.KEYS.MAP_STATE, JSON.stringify({ center, zoom }));
    } catch (e) {
      console.warn('Failed to cache map state:', e);
    }
  },

  getMapState() {
    try {
      const cached = sessionStorage.getItem(this.KEYS.MAP_STATE);
      return cached ? JSON.parse(cached) : null;
    } catch (e) {
      return null;
    }
  },

  // Corridor data
  saveCorridors(corridors) {
    try {
      sessionStorage.setItem(this.KEYS.CORRIDORS, JSON.stringify(corridors));
    } catch (e) {
      console.warn('Failed to cache corridors:', e);
    }
  },

  getCorridors() {
    try {
      const cached = sessionStorage.getItem(this.KEYS.CORRIDORS);
      return cached ? JSON.parse(cached) : null;
    } catch (e) {
      return null;
    }
  },

  // Clear all cache
  clearAll() {
    Object.values(this.KEYS).forEach(key => {
      try {
        sessionStorage.removeItem(key);
      } catch (e) {
        console.warn(`Failed to clear ${key}:`, e);
      }
    });
  },

  // Clear specific cache
  clear(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (e) {
      console.warn(`Failed to clear ${key}:`, e);
    }
  },
};

export default DataCache;