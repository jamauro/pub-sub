import './lib/mongo';
import './lib/publish';
import { clearCache } from './lib/cache';
import { config, configure } from './lib/config';

export const PubSub = Object.freeze({ config, configure, clearCache });
