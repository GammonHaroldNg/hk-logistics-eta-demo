/**
 * Application configuration constants
 */
export const CONFIG = {
  PORT: 3000,
  TRAFFIC_UPDATE_INTERVAL_MS: 60_000,
  DELIVERY_TICK_INTERVAL_MS: 1_000,
  TRUCK_SYNC_INTERVAL_MS: 5_000,
  DEFAULT_TARGET_VOLUME: 600,
  DEFAULT_TRUCKS_PER_HOUR: 12,
  DEFAULT_VOLUME_PER_TRUCK: 8,
  DEFAULT_SPEED_KMH: 40,
  /** Speed (km/h) used for segments with no TDAS data (e.g. in ETA card). */
  DEFAULT_SPEED_NO_DATA_KMH: 50,
  /** Cap (km/h) for concrete truck speed in ETA and delivery logic. */
  SPEED_CAP_KMH: 70,
} as const;
