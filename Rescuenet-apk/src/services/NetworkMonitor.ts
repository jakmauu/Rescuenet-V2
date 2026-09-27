import * as Network from 'expo-network';
import type { NetworkState } from '../models';
import { retryNow } from '../storage/Database';
import { SETTINGS } from '../config/settings';
import { api, outbox } from './runtime';
import { ApiError } from './RescueNetApi';
import { notify, reportError } from './events';

let state: NetworkState = 'CHECKING';
let nodeId: number | null = null;
let probing: Promise<void> | null = null;
export function networkSnapshot(): { state: NetworkState; nodeId: number | null } { return { state, nodeId }; }
export function checkNode(): Promise<void> {
  if (probing) return probing;
  probing = (async () => {
    const previous = state;
    try {
      const result = await api.probe();
      nodeId = result.node_id;
      state = 'CONNECTED';
      if (previous !== 'CONNECTED') retryNow();
    } catch (error) {
      nodeId = null;
      state = error instanceof ApiError && error.incompatible ? 'INCOMPATIBLE' : 'UNAVAILABLE';
    }
    notify();
    // Never gate traffic on isInternetReachable or probe success.
    await outbox.flush();
  })().finally(() => { probing = null; });
  return probing;
}
export function startNetworkMonitor(): () => void {
  void checkNode().catch(reportError);
  const timer = setInterval(() => { void checkNode().catch(reportError); }, SETTINGS.foregroundRetryMs);
  const subscription = Network.addNetworkStateListener(() => {
    try { retryNow(); void outbox.flush().catch(reportError); void checkNode().catch(reportError); }
    catch (error) { reportError(error); }
  });
  return () => { clearInterval(timer); subscription.remove(); };
}
