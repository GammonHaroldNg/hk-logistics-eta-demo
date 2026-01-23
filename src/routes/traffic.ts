import { Router } from 'express';
import { fetchTrafficSpeedMap, createTrafficResponse } from '../services/trafficService';

const router = Router();

let cachedTraffic: any = null;
let lastTrafficUpdate: Date = new Date(0);

router.get('/api/traffic-speeds', async (req, res) => {
  try {
    const now = new Date();
    if (!cachedTraffic || now.getTime() - lastTrafficUpdate.getTime() > 30000) {
      const segments = await fetchTrafficSpeedMap();
      cachedTraffic = createTrafficResponse(segments);
      lastTrafficUpdate = now;
    }
    res.json(cachedTraffic);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch traffic data' });
  }
});

export default router;