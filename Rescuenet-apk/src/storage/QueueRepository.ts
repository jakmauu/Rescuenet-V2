import type { QueueItem } from '../models';
export interface QueueRepository {
  put(item: QueueItem): void;
  get(id: string): QueueItem | null;
  next(now: number): QueueItem | null;
  update(item: QueueItem): void;
}
