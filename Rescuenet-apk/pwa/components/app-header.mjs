import { setStatusBadge } from './status-badge.mjs';

export function renderAppHeader({ badge, state, connectionLabel }) {
  const label = state.checking ? 'Memeriksa…' : state.nodeDetails ? `Node ${state.nodeDetails.node_id}` : connectionLabel;
  const tone = state.checking ? 'checking' : state.nodeDetails ? 'online' : 'offline';
  setStatusBadge(badge, label, tone);
}
