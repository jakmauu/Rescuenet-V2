import { SETTINGS } from '../config/settings';
import type { LocationPacket, NodeStatus, SosPacket } from '../models';

export class ApiError extends Error {
  constructor(message: string, readonly incompatible = false) { super(message); }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export interface NodeTransport { send(kind: 'sos' | 'location', packet: SosPacket | LocationPacket): Promise<void> }
export class RescueNetApi implements NodeTransport {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs: number = SETTINGS.requestTimeoutMs) {}
  private async request(path: string, packet?: SosPacket | LocationPacket): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(SETTINGS.nodeUrl + path, {
        method: packet ? 'POST' : 'GET',
        headers: { Accept: 'application/json', ...(packet ? { 'Content-Type': 'application/json', 'Idempotency-Key': packet.request_id } : {}) },
        body: packet ? JSON.stringify(packet) : undefined,
        signal: abort.signal,
      });
      if (!response.ok) throw new ApiError(`Field Node HTTP ${response.status}`, response.status === 404 || response.status === 405);
      if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
        throw new ApiError('Field Node belum menyediakan API mobile (balasan bukan JSON).', true);
      }
      try { return await response.json() as unknown; }
      catch { throw new ApiError('Balasan JSON Field Node tidak valid.', true); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('Node tidak terjangkau atau waktu permintaan habis. Periksa Wi-Fi RescueNet.');
    } finally { clearTimeout(timer); }
  }
  async probe(): Promise<NodeStatus> {
    const data = await this.request('/api/status');
    if (!record(data) || data.service !== 'rescuenet-field-node' || data.api_version !== 1
      || !Number.isInteger(data.node_id) || Number(data.node_id) <= 0) {
      throw new ApiError('API mobile Field Node belum kompatibel.', true);
    }
    return data as unknown as NodeStatus;
  }
  async send(kind: 'sos' | 'location', packet: SosPacket | LocationPacket): Promise<void> {
    const data = await this.request(`/api/${kind}`, packet);
    if (!record(data) || data.service !== 'rescuenet-field-node' || data.accepted !== true || data.request_id !== packet.request_id) {
      throw new ApiError('Node belum mengonfirmasi penerimaan paket ini.', true);
    }
  }
}
