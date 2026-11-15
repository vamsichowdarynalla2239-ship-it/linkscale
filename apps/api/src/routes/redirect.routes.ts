import { Router } from 'express';
import { linkController } from '../controllers/link.controller';
import { redirectRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// Public redirect route with IP-based sliding window rate limiting
router.get('/:code', redirectRateLimiter, (req, res, next) => linkController.redirect(req, res, next));

export const redirectRoutes = router;
