import { Router } from 'express';
import { getFilteredCorridors, getCorridorByRouteId } from '../services/corridorService';

const router = Router();

router.get('/api/corridors', (req, res) => {
  try {
    const corridors = getFilteredCorridors();
    res.json(corridors);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch corridors' });
  }
});

router.get('/api/corridors/:routeId', (req, res) => {
  try {
    const routeId = parseInt(req.params.routeId);
    const corridor = getCorridorByRouteId(routeId);
    if (!corridor) {
      return res.status(404).json({ error: 'Route not found' });
    }
    res.json(corridor);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch corridor' });
  }
});

export default router;