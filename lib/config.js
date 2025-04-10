import { check, Match } from 'meteor/check';

/**
 * PubSub config
 *
 * @property {boolean} cache - Enables or disables subscription caching globally. Default is `false`.
 * @property {number} cacheDuration - Duration in seconds for which subscriptions are cached. Default is `60`.
 * @property {'auto' | 'standard' | 'minimal' | 'none'} serverState - Controls how much state to retain on the server. Default is `'auto'`.
 * @property {boolean} debug - Enables console debugging output. Default is `true` in development.
 */
export const config = {
  cache: false, // globally turn subscription caching on or off, off by default.
  cacheDuration: 1 * 60, // globally set the cacheDuration in seconds, 1 min is the default.
  serverState: 'auto', // configure how much state you want to keep on the server
  debug: Meteor.isDevelopment // will provide some console.logs to help make sure you have things set up as you expect
};

/**
 * Updates the PubSub config
 *
 * @param {Object} options - Configuration overrides.
 * @param {boolean} [options.cache] - Override for enabling or disabling caching.
 * @param {number} [options.cacheDuration] - Override for cache duration in seconds.
 * @param {'auto' | 'standard' | 'minimal' | 'none'} [options.serverState] - Override for server state handling.
 * @param {boolean} [options.debug] - Override for enabling debug output.
 * @returns {typeof config} - Returns the updated configuration object.
 */
export const configure = options => {
  check(options, {
    cache: Match.Maybe(Boolean),
    cacheDuration: Match.Maybe(Number),
    serverState: Match.Maybe(Match.OneOf('auto', 'standard', 'minimal', 'none')),
    debug: Match.Maybe(Boolean)
  });

  return Object.assign(config, options);
};
