import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';
import { createKey } from './utils/shared';
import { getSubRemaining, findSub, addSub, updateSub, removeSub } from './subs-cache';
import { extractSubscribeArguments, maybeSwitchSub, mergeIntoMinimongo, removeFromMinimongo } from './utils/client';
import { config } from './config';

export const seen = {}; // mostly used as a guard for view libraries that are over actively subscribing, i.e. react-meteor-data. I think vue-meteor-tracker may have had the same issue but it seems it's fallen out of favor. If a vue user reports an issue, we can revisit trackSeen.
const trackSeen = Package['react-meteor-data'];
const ignoredSubs = ['meteor.loginServiceConfiguration', 'meteor_autoupdate_clientVersions', 'tinytest_results_subscription', '_meteor_vite'];
const originalSubscribe = Meteor.subscribe;

const signalReactiveComputations = (handle, onReady) => {
  handle._isReady = true;
  handle._readyDep.changed();
  onReady?.();
  return;
};

/**
 * @memberOf Meteor
 * @alias Meteor.subscribe
 * @summary Subscribe to a record set. Returns a handle that provides
 * `stop()` and `ready()` methods.
 * @locus Client
 * @param {String} name Name of the subscription. Matches the name of the
 * server's `publish()` call.
 * @param {EJSONable} [arg1,arg2...] Optional arguments passed to publisher
 * function on server.
 * @param {Object|Function} [options] Optional. May include `onStop`,
 * `onReady`, `cache`, and `cacheDuration`. If there is an error, it is passed as an
 * argument to `onStop`. If a function is passed instead of an object, it
 * is interpreted as an `onReady` callback.
 * @param {Function} [options.onStop] Optional. Called with no arguments
 * when the subscription is stopped.
 * @param {Function} [options.onReady] Optional. Called with no arguments
 * when the subscription is ready.
 * @param {Boolean} [options.cache] Optional. If true, the subscription will be cached. If false, it will not be cached. If not provided, the PubSub global config value will be used.
 * @param {Number} [options.cacheDuration] Optional. The duration in seconds for which the subscription will be cached. If not provided, the PubSub global config value will be used.
 * @returns {Object} A subscription handle that provides `stop()` and `ready()` methods.
 */
function subscribe(name, ...args) {
  if (!name || ignoredSubs.includes(name)) {
    return originalSubscribe.call(this, name, ...args);
  }

  const { args: subscribeArgs, onStop, onReady, cache, cacheDuration } = extractSubscribeArguments(args);

  if (!Meteor.isProduction) {
    try { cache && check(cache, Boolean) } catch (_) {
      throw new Error(`cache must be true or false for subscription '${name}'`)
    }
    try { cacheDuration && check(cacheDuration, Number) } catch (_) {
      throw new Error(`cacheDuration must be a number for subscription '${name}'`)
    }
    if (cacheDuration > 0 && cache === false) {
      throw new Error(`Cannot set { cache: false } with a duration for subscription '${name}'`)
    }
  }

  const shouldCache = cacheDuration === 0 ? false : (cacheDuration ? cacheDuration > 0 : (cache ?? config.cache));
  const duration = cacheDuration === Infinity ? Infinity : (cacheDuration ?? config.cacheDuration) * 1000; // convert seconds to milliseconds to use for timeouts and remaining calculation
  const key = createKey({ name, args: subscribeArgs });
  const { handle: cachedSubHandle, duration: cachedDuration, timeoutId: cachedTimeoutId } = (shouldCache && findSub(key)) || {};
  const c = Tracker.currentComputation;

  // if we are inside a Tracker computation, we stop when it stops -- e.g. when a component is destroyed
  c.onInvalidate(function() {
    if (!c.stopped || trackSeen && c._id < 3) return; // see trackSeen above to understand why this is here

    const { handle } = (findSub(key) || seen[key]) || {};
    handle?.stop(true);
  });

  if (cachedSubHandle) {
    const isSimulated = '_isReady' in cachedSubHandle;
    const remaining = getSubRemaining(key);

    if (remaining > 0) { // if the sub was cached and has time remaining, just reuse it
      // CACHE HIT

      updateSub({ key, active: true }) // it's the currently active sub

      if (cachedTimeoutId) {
        clearTimeout(cachedTimeoutId);
      }

      return cachedSubHandle;
    }

    // if cache no longer has time remaining and it's a .once publication, invalidate the sub handle to prepare for a new data fetch
    // we use _isReady to differentiate between a regular publication and a .once publication
    if (isSimulated) {
      cachedSubHandle._isReady = false;
      cachedSubHandle._readyDep?.changed();
    }
  }

  // CACHE MISS
  const { once = [], stream = [] } = Meteor.settings.public.packages?.['jam:pub-sub']?.pubs || {};
  const isOnce = once.includes(name);
  const isStream = stream.includes(name);
  const isStandard = !isOnce && !isStream;

  const clean = (name, handle) => {
    if (isStandard && config.serverState !== 'none') return;

    const { _collectionNames, subscriptionId, params } = handle;
    maybeSwitchSub(name, params, _collectionNames, shouldCache); // if we're doing things like infinite scroll with .stream or .once, we switch existing docs to the newly active sub
    removeFromMinimongo(_collectionNames, subscriptionId);
    return;
  };

  // standard and .stream publications
  if (!isOnce) {
    const nameLowerCased = name.toLowerCase();

    const handle = originalSubscribe.call(this, name, ...subscribeArgs, ...(onStop || onReady ? [{ ...(onStop && { onStop }), ...(onReady && { onReady }) }] : []));
    const originalStop = handle.stop;
    handle._collectionNames = Object.keys(Meteor.connection._mongo_livedata_collections).filter(c => nameLowerCased.includes(c.toLowerCase()));
    handle.params = subscribeArgs;

    if (!shouldCache) {
      if (isStream) { // we may need to cleanup .stream data from minimongo
        handle.stop = () => {
          originalStop();
          clean(name, handle);
          return;
        }
      }

      return handle;
    }

    // we're caching
    handle.name = name;
    handle.stop = (invalidated) => {
      if (!invalidated) return; // some view layers like react with react-meteor-data weirdly call .stop a bunch, we only want this to run when the component containing the subscription has been destroyed
      if (duration === Infinity) return;

      const timeoutId = setTimeout(() => {
        originalStop();
        clean(name, handle);
        return removeSub(key);
      }, duration);

      return updateSub({ key, timeoutId, active: false, refreshedAt: new Date() });
    };

    addSub({ key, handle, duration, active: true });

    return handle;
  }

  if (trackSeen) { // using seen to prevent possible infinite subscription loop. subscribe can fire multiple times very quickly with things like react-meteor-data, I think it's a bug in that package
    const { handle } = seen[key] || {};

    if (handle) {
      signalReactiveComputations(handle, onReady);
      return handle;
    }
  }

  // .once publications
  // simulate the original Meteor.subscribe handle
  const subHandle = {
    _isReady: false,
    _readyDep: new Tracker.Dependency(),
    subscriptionId: Random.id(),
    name,
    params: subscribeArgs,
    stop(invalidated) {
      if (!invalidated) return;
      if (duration === Infinity) return;

      onStop?.();
      delete seen[key];

      if (!shouldCache) {
        // needs to run after .stop so we use Promise.resolve to wait a tick
        return Promise.resolve().then(() => clean(name, subHandle));
      }

      // cached subs
      const timeoutId = setTimeout(() => {
        clean(name, subHandle);
        return removeSub(key);
      }, duration);

      return updateSub({ key, timeoutId, active: false, refreshedAt: new Date() });
    },
    ready() {
      this._readyDep.depend();
      return this._isReady;
    },
  };

  if (trackSeen) (seen[key] ??= {}).handle = subHandle; // guard for libraries that subscribe over actively, e.g. react-meteor-data

  Meteor.apply(name, subscribeArgs, {}, (error, data) => {
    if (error) {
      onStop?.(error); // original behavior when a subscription fails
      return removeSub(key);
    }

    subHandle._collectionNames = Object.keys(data);

    if (shouldCache) {
      addSub({ key, handle: subHandle, duration, active: true });
    }

    // Signal reactive recomputations
    // Note: In case we found an active cachedSubHandle, it might already be in
    // ready state and UI reactivity might already be initialized. To avoid UI
    // flashing when updating, inside mergeIntoMinimongo() we always manually
    // turn off reactivity before carrying out updates.
    mergeIntoMinimongo(data, subHandle.subscriptionId);
    signalReactiveComputations(subHandle, onReady);

    return;
  });

  return subHandle;
};



Meteor.subscribe = subscribe;
