import { MapBase } from './shared/map-base.js';
import { ApiClient } from './shared/api.js';
import { DataCache } from './shared/storage.js';
import { UPDATE_INTERVALS, TRAFFIC_STATES } from './shared/constants.js';

class TrackingPage {
  constructor() {
    this.map = null;
    this.routeId = null;
    this.trucks = [];
    this.trafficData = null;
    this.updateInterval = null;
    this.corridors = null;
  }

  async init() {
    console.log('Initializing Tracking page...');

    // Get route from URL parameter
    const params = new URLSearchParams(window.location.search);
    this.routeId = params.get('route') ? parseInt(params.get('route')) : null;

    // Initialize map
    this.map = new MapBase('map');
    await this.map.initialize();
    console.log('✓ Map initialized');

    // Load corridors
    await this.loadCorridors();

    // Populate route selector
    await this.populateRouteSelector();

    // Load initial data
    await this.loadData();

    // Setup event listeners
    this.setupEventListeners();

    // Setup auto-update
    this.startAutoUpdate();

    console.log('✓ Tracking page ready');
  }

  async loadCorridors() {
    const cached = DataCache.getCorridors();
    if (cached) {
      this.corridors = cached;
      return;
    }

    this.corridors = await ApiClient.fetchCorridors();
    DataCache.saveCorridors(this.corridors);
  }

  populateRouteSelector() {
    const select = document.getElementById('routeSelect');
    const routes = Object.keys(this.corridors).map(Number);

    routes.forEach(routeId => {
      const option = document.createElement('option');
      option.value = routeId;
      option.textContent = `Route ${routeId}`;
      select.appendChild(option);
    });

    if (this.routeId && routes.includes(this.routeId)) {
      select.value = this.routeId;
    }
  }

  async loadData() {
    if (!this.routeId) {
      alert('Please select a route');
      return;
    }

    const cachedTraffic = DataCache.getTrafficData();
    if (cachedTraffic) {
      this.trafficData = cachedTraffic;
    }

    const traffic = await ApiClient.fetchTraffic();
    this.trafficData = traffic;

    const trucks = await ApiClient.fetchTrucks();
    this.trucks = trucks.filter(t => t.routeId === this.routeId);

    this.updateDisplay();
  }

  updateDisplay() {
    this.updateRouteOnMap();
    this.updateVehicleList();
    this.updateRouteInfo();
  }

  updateRouteOnMap() {
    const corridor = this.corridors[this.routeId];
    if (!corridor) return;

    // Remove old route layer if exists
    if (this.map.map.getLayer('route-layer')) {
      this.map.map.removeLayer('route-layer');
    }
    if (this.map.map.getSource('route-source')) {
      this.map.map.removeSource('route-source');
    }

    // Add new route
    this.map.addSource('route-source', {
      type: 'geojson',
      data: corridor,
    });

    this.map.addLayer({
      id: 'route-layer',
      type: 'line',
      source: 'route-source',
      paint: {
        'line-color': '#3b82f6',
        'line-width': 3,
      },
    });

    // Fly to route
    const coords = corridor.geometry.coordinates;
    const bounds = this.getBounds(coords);
    this.map.map.fitBounds(bounds, { padding: 50 });
  }

  updateVehicleList() {
    const list = document.getElementById('vehicleList');
    list.innerHTML = '';

    if (this.trucks.length === 0) {
      list.innerHTML = '<p style="color: #6b7280; font-size: 14px;">No vehicles on this route</p>';
      return;
    }

    this.trucks.forEach(truck => {
      const item = document.createElement('div');
      item.className = 'vehicle-item';
      item.innerHTML = `
        <div class="vehicle-item-id">${truck.id}</div>
        <div class="vehicle-item-eta">ETA: ${this.calculateETA(truck)}</div>
      `;
      list.appendChild(item);
    });
  }

  updateRouteInfo() {
    const info = document.getElementById('routeInfo');
    info.innerHTML = `
      <div class="route-info-item">
        <div class="route-info-label">Route ID</div>
        <div class="route-info-value">${this.routeId}</div>
      </div>
      <div class="route-info-item">
        <div class="route-info-label">Active Vehicles</div>
        <div class="route-info-value">${this.trucks.length}</div>
      </div>
      <div class="route-info-item">
        <div class="route-info-label">Last Update</div>
        <div class="route-info-value">${new Date().toLocaleTimeString('en-HK')}</div>
      </div>
    `;
  }

  calculateETA(truck) {
    // Placeholder ETA calculation
    return 'In Transit';
  }

  getBounds(coords) {
    const bounds = [
      [coords, coords],
      [coords, coords],
    ];
    coords.forEach(coord => {
      if (coord < bounds) bounds = coord;
      if (coord < bounds) bounds = coord;
      if (coord > bounds) bounds = coord;
      if (coord > bounds) bounds = coord;
    });
    return bounds;
  }

  setupEventListeners() {
    document.getElementById('routeSelect').addEventListener('change', (e) => {
      this.routeId = e.target.value ? parseInt(e.target.value) : null;
      if (this.routeId) {
        window.history.replaceState({}, '', `?route=${this.routeId}`);
        this.loadData();
      }
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
      this.loadData();
    });
  }

  startAutoUpdate() {
    this.updateInterval = setInterval(() => {
      this.loadData();
    }, UPDATE_INTERVALS.TRACKING);
    console.log(`Auto-update started (every 30 seconds)`);
  }

  destroy() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.map) this.map.destroy();
  }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  const page = new TrackingPage();
  page.init().catch(error => {
    console.error('Failed to initialize tracking:', error);
    alert('Failed to load page. Please refresh.');
  });

  window.addEventListener('beforeunload', () => {
    page.destroy();
  });
});