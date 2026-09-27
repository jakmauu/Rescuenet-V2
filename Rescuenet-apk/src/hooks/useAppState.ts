import { useSyncExternalStore } from 'react';
import { getRevision, subscribe } from '../services/events';

// Snapshot is a stable primitive. Components read SQLite after each revision.
export function useAppState(): void { useSyncExternalStore(subscribe, getRevision, getRevision); }
