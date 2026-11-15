import { Router } from 'express';
import { linkController } from '../controllers/link.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { createLinkRateLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// All link management routes require valid API key authentication
router.use(requireAuth);

router.post('/', createLinkRateLimiter, (req, res, next) => linkController.createLink(req, res, next));
router.get('/', (req, res, next) => linkController.listLinks(req, res, next));
router.get('/search', (req, res, next) => linkController.searchLinks(req, res, next));
router.get('/:id/analytics', (req, res, next) => linkController.getAnalytics(req, res, next));
router.get('/:id', (req, res, next) => linkController.getLinkById(req, res, next));
router.patch('/:id', (req, res, next) => linkController.updateLink(req, res, next));
router.delete('/:id', (req, res, next) => linkController.deleteLink(req, res, next));

export const linkRoutes = router;
