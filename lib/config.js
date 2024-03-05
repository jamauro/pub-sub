import { check } from 'meteor/check';
import { clearCache } from './subs-cache';

const config = {
  cache: false, // globally turn subscription caching on or off, off by default.
  cacheDuration: 1 * 60 // globally set the cacheDuration in seconds, 1 min is the default.
};

const configure = options => {
  check(options, {
    cache: Match.Maybe(Boolean),
    cacheDuration: Match.Maybe(Number),
  });

  return Object.assign(config, options);
}

export const PubSub = {
  config,
  configure,
  clearCache
};
