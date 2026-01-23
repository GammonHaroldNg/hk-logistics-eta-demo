/**
 * Centralized API Client
 * Single source of truth for all API calls
 */

import { API_ENDPOINTS } from './constants.js';
import { DataCache } from './storage.js';

export const ApiClient = {
  // Fetch traffic speeds
  async fetchTraffic() {
    try {
      const response = await fetch(API_ENDPOINTS.TRAFFIC);
      if (!response.ok) throw new Error('Failed to fetch traffic');
      const data = await response.json();
      DataCache.saveTrafficData(data);
      return data;
    } catch (error) {
      console.error('Traffic API error:', error);
      // Return cached data if available
      return DataCache.getTrafficData() || { segments: {}, stateMap: {} };
    }
  },

  // Fetch all corridors
  async fetchCorridors() {
    try {
      const response = await fetch(API_ENDPOINTS.CORRIDORS);
      if (!response.ok) throw new Error('Failed to fetch corridors');
      const data = await response.json();
      DataCache.saveCorridors(data);
      return data;
    } catch (error) {
      console.error('Corridors API error:', error);
      return DataCache.getCorridors() || {};
    }
  },

  // Fetch specific corridor
  async fetchCorridor(routeId) {
    try {
      const response = await fetch(`${API_ENDPOINTS.CORRIDORS}/${routeId}`);
      if (!response.ok) throw new Error(`Failed to fetch corridor ${routeId}`);
      return await response.json();
    } catch (error) {
      console.error(`Corridor ${routeId} API error:`, error);
      return null;
    }
  },

  // Fetch all trucks
  async fetchTrucks() {
    try {
      const response = await fetch(API_ENDPOINTS.TRUCKS);
      if (!response.ok) throw new Error('Failed to fetch trucks');
      return await response.json();
    } catch (error) {
      console.error('Trucks API error:', error);
      return [];
    }
  },

  // Fetch specific truck
  async fetchTruck(truckId) {
    try {
      const response = await fetch(`${API_ENDPOINTS.TRUCKS}/${truckId}`);
      if (!response.ok) throw new Error(`Failed to fetch truck ${truckId}`);
      return await response.json();
    } catch (error) {
      console.error(`Truck ${truckId} API error:`, error);
      return null;
    }
  },
};

export default ApiClient;