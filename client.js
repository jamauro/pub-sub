import './lib/subscribe';
import './lib/ddp';
import { clearCache } from './lib/subs-cache';
import { config, configure } from './lib/config';

export const PubSub = Object.freeze({ config, configure, clearCache });
