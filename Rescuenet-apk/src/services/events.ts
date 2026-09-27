const listeners = new Set<() => void>();
let revision = 0;
export function notify(): void { revision++; listeners.forEach(listener => listener()); }
export function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getRevision(): number { return revision; }
let runtimeError: string | null = null;
export function reportError(error: unknown): void {
  runtimeError = error instanceof Error ? error.message : 'Operasi gagal. Coba kembali.';
  // Never log coordinates, names or packet bodies.
  console.warn('[RescueNet] Operasi gagal; detail tersedia pada layar aplikasi.');
  notify();
}
export function getRuntimeError(): string | null { return runtimeError; }
export function clearError(): void { runtimeError = null; notify(); }
