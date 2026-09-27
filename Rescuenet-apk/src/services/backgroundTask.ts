import * as TaskManager from 'expo-task-manager';
import type { LocationObject } from 'expo-location';
import { SETTINGS } from '../config/settings';
import { readSetting, writeSetting } from '../storage/Database';
import { fromNative } from './LocationService';
import { receiveLocation } from './TrackingService';
import { outbox } from './runtime';
import { reportError } from './events';

// Loaded by index.ts before mounting React, including headless native launches.
TaskManager.defineTask<{ locations: LocationObject[] }>(SETTINGS.backgroundTask, async ({ data, error }) => {
  try {
    if (error) { writeSetting('trackingError', error.message); reportError(new Error(error.message)); return; }
    if (readSetting('tracking') !== 'background') return;
    const newest = data?.locations?.reduce<LocationObject | undefined>((latest, item) =>
      !latest || item.timestamp > latest.timestamp ? item : latest, undefined);
    if (newest) receiveLocation(fromNative(newest));
    await outbox.flush();
  } catch (failure) { reportError(failure); }
});
