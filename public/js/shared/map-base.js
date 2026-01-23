/**
 * MapLibre Initialization & Utilities
 * Shared map functions for both pages
 */

import { MAP_CONFIG } from './constants.js';

export class MapBase {
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.options = { ...MAP_CONFIG, ...options };
    this.map = null;
    this.layers = {};
    this.sources = {};
  }

  async initialize() {
    // Check if MapLibre GL is available
    if (typeof maplibregl === 'undefined') {
      throw new Error('MapLibre GL JS library not loaded');
    }

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: this.options.STYLE,
      center: this.options.CENTER,
      zoom: this.options.ZOOM,
    });

    return new Promise((resolve) => {
      this.map.on('load', resolve);
    });
  }

  // Add source
  addSource(id, source) {
    if (!this.map.getSource(id)) {
      this.map.addSource(id, source);
      this.sources[id] = source;
    }
  }

  // Add layer
  addLayer(layerDef) {
    if (!this.map.getLayer(layerDef.id)) {
      this.map.addLayer(layerDef);
      this.layers[layerDef.id] = layerDef;
    }
  }

  // Smooth fly to location
  flyTo(center, zoom = 12) {
    this.map.flyTo({
      center,
      zoom,
      speed: 1.5,
      duration: 2000,
    });
  }

  // Get current state
  getState() {
    const center = this.map.getCenter();
    return {
      center: [center.lng, center.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
    };
  }

  // Restore state
  restoreState(state) {
    if (!state) return;
    this.map.jumpTo({
      center: state.center,
      zoom: state.zoom,
      bearing: state.bearing,
      pitch: state.pitch,
    });
  }

  // Destroy
  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }
}

export default MapBase;