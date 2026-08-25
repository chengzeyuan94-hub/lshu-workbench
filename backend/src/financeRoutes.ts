import type { Express, Response } from 'express';
import { FinanceService, FinanceServiceError } from './finance/financeService';

export interface RegisterFinanceRoutesOptions {
  service?: FinanceService;
}

function sendFinanceError(res: Response, error: unknown): void {
  if (error instanceof FinanceServiceError) {
    res.status(error.httpStatus).json({ code: error.code, message: error.message });
    return;
  }
  res.status(500).json({
    code: 'FINANCE_INTERNAL_ERROR',
    message: '财务服务暂时不可用',
  });
}

export function registerFinanceRoutes(
  app: Express,
  options: RegisterFinanceRoutesOptions = {},
): FinanceService {
  const service = options.service ?? new FinanceService();

  app.get('/api/finance/overview', async (_req, res) => {
    try {
      res.json(await service.getOverview());
    } catch (error) {
      sendFinanceError(res, error);
    }
  });

  app.get('/api/finance/status', async (_req, res) => {
    try {
      res.json(await service.getStatus());
    } catch (error) {
      sendFinanceError(res, error);
    }
  });

  app.post('/api/finance/sync', async (_req, res) => {
    try {
      res.json(await service.sync());
    } catch (error) {
      sendFinanceError(res, error);
    }
  });

  return service;
}
