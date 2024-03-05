import './lib/mongo';
import './lib/publish';
import { PubSub as PS } from './lib/config';

export const PubSub = Object.freeze(PS);
