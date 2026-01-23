import { Router } from 'express';
import { trucks } from '../services/simulation';

const router = Router();

router.get('/api/trucks', (req, res) => {
  try {
    res.json(trucks);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trucks' });
  }
});

export default router;
