import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export const palette = { ink: '#17334c', muted: '#536679', background: '#f2f5f8', line: '#dce4ec',
  green: '#087c5b', red: '#b91c32', amber: '#855200' };
export function Card({ title, children }: PropsWithChildren<{ title: string }>) {
  return <View style={styles.card}><Text style={styles.label}>{title}</Text>{children}</View>;
}
export function Button({ title, onPress, disabled = false, danger = false, secondary = false }:
  { title: string; onPress: () => void; disabled?: boolean; danger?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.button, danger && styles.danger,
      secondary && styles.secondary, (disabled || pressed) && { opacity: 0.55 }]}>
    <Text style={[styles.buttonText, secondary && { color: palette.ink }]}>{title}</Text>
  </Pressable>;
}
export function Detail({ label, value }: { label: string; value: string }) {
  return <View style={styles.detail}><Text style={styles.muted}>{label}</Text><Text selectable style={styles.value}>{value}</Text></View>;
}
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.background },
  content: { padding: 20, paddingBottom: 44, gap: 16, width: '100%', maxWidth: 640, alignSelf: 'center' },
  title: { fontSize: 30, fontWeight: '800', color: palette.ink },
  subtitle: { fontSize: 15, color: palette.muted, lineHeight: 22 },
  card: { backgroundColor: '#fff', borderWidth: 1, borderColor: palette.line, borderRadius: 18, padding: 20, gap: 12 },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 1.2, color: palette.muted },
  heading: { fontSize: 22, fontWeight: '700', color: palette.ink },
  muted: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  value: { color: palette.ink, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  detail: { gap: 3 },
  button: { backgroundColor: palette.ink, borderRadius: 12, padding: 17, minHeight: 54, justifyContent: 'center', alignItems: 'center' },
  buttonText: { fontSize: 16, fontWeight: '700', color: '#fff', textAlign: 'center' },
  danger: { backgroundColor: palette.red, minHeight: 94 },
  secondary: { backgroundColor: '#eaf0f5' },
  input: { borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 16, fontSize: 18, color: palette.ink, backgroundColor: '#fff' },
  error: { color: palette.red, fontSize: 15, lineHeight: 22 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  separator: { height: 1, backgroundColor: palette.line },
});
