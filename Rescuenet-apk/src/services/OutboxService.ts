import { SETTINGS } from '../config/settings';
import type { QueueItem } from '../models';
import type { QueueRepository } from '../storage/QueueRepository';
import type { NodeTransport } from './RescueNetApi';

// One worker shared by UI, network callbacks and native background task in this JS runtime.
// Persist SENDING before HTTP. On restart it is recovered as QUEUED with the same id.
export class OutboxService {
  private running: Promise<void> | null = null;
  constructor(private readonly repository: QueueRepository, private readonly transport: NodeTransport,
    private readonly changed: () => void = () => {}, private readonly now = Date.now) {}
  enqueue(item: QueueItem): void { this.repository.put(item); this.changed(); }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  private async drain(): Promise<void> {
    // Bounded work for OS background execution. Due SOS always precedes location.
    for (let count = 0; count < 4; count++) {
      const item = this.repository.next(this.now());
      if (!item) return;
      item.status = 'SENDING';
      item.attempts++;
      this.repository.update(item);
      this.changed();
      try {
        await this.transport.send(item.kind, item.payload);
      } catch (error) {
        item.status = 'QUEUED';
        item.lastError = error instanceof Error ? error.message : 'Transmisi gagal.';
        item.nextAttemptAt = this.now() + Math.min(SETTINGS.retryMaxMs, 5000 * 2 ** Math.min(item.attempts, 6));
        this.repository.update(item);
        this.changed();
        continue;
      }
      item.status = 'DELIVERED';
      item.deliveredAt = this.now();
      item.lastError = null;
      // An acknowledgement is retained; delivered SOS are never silently deleted.
      this.repository.update(item);
      this.changed();
    }
  }
}
