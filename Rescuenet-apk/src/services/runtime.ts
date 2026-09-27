import { repository } from '../storage/Database';
import { notify } from './events';
import { OutboxService } from './OutboxService';
import { RescueNetApi } from './RescueNetApi';

export const api = new RescueNetApi();
export const outbox = new OutboxService(repository, api, notify);
