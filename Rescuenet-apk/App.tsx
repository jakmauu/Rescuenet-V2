import React, { useEffect } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { HomeScreen } from './src/screens/HomeScreen';
import { SetupScreen } from './src/screens/SetupScreen';
import { readSetting } from './src/storage/Database';
import { useAppState } from './src/hooks/useAppState';
import { startNetworkMonitor } from './src/services/NetworkMonitor';
import { reconcileTracking, suspendForegroundWatcher } from './src/services/TrackingService';
import { notify, reportError } from './src/services/events';
import { Button, styles } from './src/components/ui';

class StorageBoundary extends React.Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <View style={styles.content}><Text style={styles.heading}>Data aplikasi belum dapat dibaca</Text><Text style={styles.error}>Jangan menghapus data atau uninstall: antrean SOS dapat hilang. Periksa ruang penyimpanan, kemudian coba kembali. SOS belum dapat dikirim dari layar ini.</Text><Button title="Coba kembali" onPress={() => this.setState({ failed: false })} /></View>;
    return this.props.children;
  }
}
function Application() {
  useAppState();
  const user = readSetting('user');
  useEffect(() => {
    if (!user) return;
    let stopMonitor: (() => void) | null = null;
    function resume() {
      stopMonitor?.();
      stopMonitor = startNetworkMonitor();
      void reconcileTracking().catch(reportError);
    }
    if (AppState.currentState === 'active') resume();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') resume();
      else { stopMonitor?.(); stopMonitor = null; suspendForegroundWatcher(); }
      notify();
    });
    // Re-render freshness and queued status even when stationary.
    const clock = setInterval(notify, 5000);
    return () => { stopMonitor?.(); listener.remove(); clearInterval(clock); suspendForegroundWatcher(); };
  }, [user?.user_id]);
  return user ? <HomeScreen /> : <SetupScreen />;
}
export default function App() {
  return <SafeAreaProvider><SafeAreaView style={styles.page}><StatusBar barStyle="dark-content" /><StorageBoundary><Application /></StorageBoundary></SafeAreaView></SafeAreaProvider>;
}
