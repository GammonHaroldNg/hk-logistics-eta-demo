import { MapBase } from './shared/map-base.js';
import { ApiClient } from './shared/api.js';
import { DataCache } from './shared/storage.js';
import { UPDATE_INTERVALS, TRAFFIC_STATES } from './shared/constants.js';

class OverviewPage {
  constructor() {
    this.map = null;
    this.trafficData = null;
    this.updateInterval = null;
  }

  async init() {
    console.log('Initializing Overview page...');

    // Initialize map
    this.map = new MapBase('map');
    await this.map.initialize();
    console.log('✓ Map initialized');

    // Add traffic layer
    this.addTrafficLayer({
      id: 'traffic-layer',
      type: 'line',
      source: 'traffic-source',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
      },
    });
    // Click on a route line to show details
    this.map.map.on('click', 'traffic-layer', (e) => {
      const features = this.map.map.queryRenderedFeatures(e.point, {
        layers: ['traffic-layer'],
      });
      if (!features || !features.length) return;

      const feature = features[0];
      this.showRouteDetails(feature);
    });

    // Optional: change cursor on hover
    this.map.map.on('mouseenter', 'traffic-layer', () => {
      this.map.map.getCanvas().style.cursor = 'pointer';
    });
    this.map.map.on('mouseleave', 'traffic-layer', () => {
      this.map.map.getCanvas().style.cursor = '';
    });

    // Load initial data
    await this.loadTraffic();

    // Setup event listeners
    this.setupEventListeners();

    // Setup auto-update
    this.startAutoUpdate();

    console.log('✓ Overview page ready');
  }

  async loadTraffic() {
    const cachedData = DataCache.getTrafficData();
    if (cachedData) {
      this.updateTrafficDisplay(cachedData);
      console.log('Loaded from cache');
    }

    const data = await ApiClient.fetchTraffic();
    this.trafficData = data;
    this.updateTrafficDisplay(data);
    this.updateStats();
    this.updateTimestamp();
  }

  updateTrafficDisplay(data) {
    if (!data || !data.stateMap) return;

    const source = this.map.map.getSource('traffic-source');
    if (!source) {
      console.warn('Traffic source not found');
      return;
    }

    // You need corridors (routes GeoJSON) loaded somewhere earlier:
    // this.corridors = { type: 'FeatureCollection', features: [...] }
    if (!this.corridors) {
      console.warn('No corridors data loaded');
      return;
    }

    const stateMap = data.stateMap;
    const features = this.corridors.features.map((f) => {
      const routeId = f.properties.ROUTEID;
      const traffic = stateMap[routeId] || stateMap[String(routeId)] || null;
      const hasTdas = !!traffic;
      const state = hasTdas ? (traffic.state || 'UNKNOWN') : 'NO DATA';

      const color = hasTdas
        ? (state === 'GREEN' ? '#22c55e'
          : state === 'YELLOW' ? '#eab308'
          : state === 'RED' ? '#ef4444'
          : '#8b5cf6')
        : '#4b5563'; // dark grey for no TDAS

      return {
        ...f,
        properties: {
          ...f.properties,
          color, // used by 'line-color' in addTrafficLayer
        },
      };
    });

    source.setData({
      type: 'FeatureCollection',
      features,
    });
  }

  addTrafficLayer() {
    // Add traffic source and layer to map
    this.map.addSource('traffic-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    this.map.addLayer({
      id: 'traffic-layer',
      type: 'line',
      source: 'traffic-source',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
      },
    });
  }

  updateStats() {
    if (!this.trafficData || !this.trafficData.stateMap) return;

    const states = { GREEN: 0, YELLOW: 0, RED: 0 };
    for (const [, state] of this.trafficData.stateMap) {
      states[state]++;
    }

    document.getElementById('greenCount').textContent = states.GREEN;
    document.getElementById('yellowCount').textContent = states.YELLOW;
    document.getElementById('redCount').textContent = states.RED;
  }

  updateTimestamp() {
    const now = new Date().toLocaleTimeString('en-HK');
    document.getElementById('lastUpdate').textContent = `Last updated: ${now}`;
  }

  setupEventListeners() {
    document.getElementById('refreshBtn').addEventListener('click', () => {
      this.loadTraffic();
    });
  }

  startAutoUpdate() {
    this.updateInterval = setInterval(() => {
      this.loadTraffic();
    }, UPDATE_INTERVALS.OVERVIEW);
    console.log(`Auto-update started (every 5 minutes)`);
  }

  destroy() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.map) this.map.destroy();
  }
}



// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  const page = new OverviewPage();
  page.init().catch(error => {
    console.error('Failed to initialize overview:', error);
    alert('Failed to load page. Please refresh.');
  });

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    page.destroy();
  });
});