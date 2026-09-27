import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput } from 'react-native';
import { Button, Card, styles } from '../components/ui';
import { createUser } from '../storage/UserStorage';
import { refreshGps } from '../services/LocationService';
import { reportError } from '../services/events';

export function SetupScreen() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  function save() {
    try {
      createUser(name);
      // Profile survives even if GPS permission is declined.
      void refreshGps().catch(reportError);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Profil gagal disimpan.'); }
  }
  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>RescueNet</Text>
      <Text style={styles.subtitle}>Emergency Communication · Lokal, tanpa internet</Text>
      <Card title="SELAMAT DATANG">
        <Text style={styles.heading}>Siapkan identitas Anda</Text>
        <Text style={styles.muted}>Nama dan ID disimpan di HP ini. Tidak perlu akun cloud. ID unik dibuat otomatis.</Text>
        <TextInput accessibilityLabel="Nama Anda" placeholder="Nama lengkap" placeholderTextColor="#667789"
          autoCapitalize="words" autoCorrect={false} maxLength={60} value={name} onChangeText={setName} style={styles.input} />
        <Text style={styles.muted}>RescueNet memerlukan lokasi HP agar petugas dapat menerima posisi Anda saat tracking aktif atau SOS dikirim. Izin lokasi akan diminta setelah profil disimpan. Tracking tidak dimulai otomatis.</Text>
        <Text style={styles.muted}>Jika izin ditolak, SOS tanpa GPS tetap dapat disimpan dan dicoba dikirim.</Text>
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <Button title="Simpan profil & lanjutkan" onPress={save} disabled={name.trim().length < 2} />
      </Card>
      <Text style={styles.muted}>Prototipe capstone. Bukan pengganti layanan darurat resmi; penerimaan di node tidak menjamin bantuan sudah dikirim.</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}
