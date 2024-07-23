import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Tracker } from 'meteor/tracker';
import { Random } from 'meteor/random';
import { generateCacheKey, getSubRemaining, findSub, addSub, updateSub, removeSub } from './subs-cache';
import { extractSubscribeArguments, mergeIntoMinimongo, removeFromMinimongo, createIdMap } from './utils/client';
import { PubSub } from './config';

export const seen = {};
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

  const shouldCache = cacheDuration === 0 ? false : (cacheDuration ? cacheDuration > 0 : (cache ?? PubSub.config.cache));
  const duration = (cacheDuration ?? PubSub.config.cacheDuration) * 1000; // convert seconds to milliseconds to use for timeouts and remaining calculation
  const key = generateCacheKey({ name, args: subscribeArgs });
  const { handle: cachedSubHandle, duration: cachedDuration, ids: cachedIds, timeoutId } = (shouldCache && findSub(key)) || {};
  const c = Tracker.currentComputation;

  // if we are inside a Tracker computation, we stop when it stops -- e.g. when a component is destroyed
  if (c?.firstRun) {
    c.onInvalidate(function() {
      if (c.stopped) {
        const { handle } = (findSub(key) || seen[key]) || {};
        handle?.stop();
      }
    });
  }

  if (cachedSubHandle) {
    const isSimulated = '_isReady' in cachedSubHandle;
    const remaining = getSubRemaining(key);

    if (remaining > 0) { // if the sub was cached and has time remaining, just reuse it
      // CACHE HIT
      updateSub({ key, active: true }) // it's the currently active sub

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (cachedDuration - remaining < 20) { // subscribe can fire multiple times very quickly if you aren't careful, most of the time it's harmless but in this case we want to return early
        return cachedSubHandle;
      }

      if (cachedIds) {
        Promise.resolve().then(() => { // used to make this run after the .stop is called on the previous handle
          const localCollections = Meteor.connection._mongo_livedata_collections;
          const modifier = isSimulated ? {$set: {__sub: cachedSubHandle.subscriptionId}} : {$unset: {__sub: ''}};

          for (const collectionName of cachedSubHandle._collectionNames) {
            localCollections[collectionName].update({_id: {$in: cachedIds[collectionName]}}, modifier, {multi: true});
          }

          // clean up cachedIds. this isn't absolutely necessary but it's an optimization that cleans up data that we shouldn't need anymore. if it causes issues, it can be safely removed. the timeout on the sub will eventually remove all the data for that sub.
          delete findSub(key).ids;
        });
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

  // this is for regular publications
  if (!Meteor.settings.public.packages?.['jam:pub-sub']?.pubs?.once?.includes(name)) {
    const nameLowerCased = name.toLowerCase();
    const handle = originalSubscribe.call(this, name, ...subscribeArgs, ...(onStop || onReady ? [{ ...(onStop && { onStop }), ...(onReady && { onReady }) }] : []));
    handle._collectionNames = Object.keys(Meteor.connection._mongo_livedata_collections).filter(c => nameLowerCased.includes(c.toLowerCase()));

    if (shouldCache) {
      const originalStop = handle.stop;
      handle.stop = () => {
        if (c?._onInvalidateCallbacks.length) return; // prevents .stop from being called multiple times, not sure why this happens. might be a Meteor bug.

        const remaining = getSubRemaining(key); // some view layers, like React with react-meteor-data, call .stop multiple times before the component is destroyed. we only want to run the rest of this when the component is destroyed.
        if (duration - remaining < 20) return;

        const timeoutId = setTimeout(() => {
          originalStop();
          return removeSub(key);
        }, duration);

        const ids = createIdMap(handle._collectionNames, {__sub: {$exists: false}})

        return updateSub({ key, timeoutId, ids, active: false, refreshedAt: new Date() });
      };

      addSub({ key, handle, duration, active: true });
    }

    return handle;
  }

  if (!shouldCache) { // when not caching subscriptions, using seen to prevent possible infinite subscription loop. subscribe can fire multiple times very quickly if you aren't careful, most of the time it's harmless but in this case we want to return early
    const { handle } = seen[key] || {};

    if (handle) {
      signalReactiveComputations(handle, onReady);
      return handle;
    }
  }

  // simulate the original Meteor.subscribe handle
  const subHandle = {
    _isReady: false,
    _readyDep: new Tracker.Dependency(),
    subscriptionId: Random.id(),
    stop() {
      onStop?.();

      /// cleanup minimongo
      const { _collectionNames, subscriptionId } = subHandle;

      if (!shouldCache) {
        delete seen[key];
        // needs to run after .stop and after a cachedSubHandle has processed any cachedIds so we use Promise.resolve twice
        return Promise.resolve().then(() => Promise.resolve()).then(() =>
          removeFromMinimongo(_collectionNames, subscriptionId));
      }

      // cached subs
      const timeoutId = setTimeout(() => {
        removeFromMinimongo(_collectionNames, subscriptionId);
        return removeSub(key);
      }, duration);

      const ids = createIdMap(_collectionNames, {__sub: subscriptionId});

      return updateSub({ key, timeoutId, ids, active: false, refreshedAt: new Date() });
      /// end minimongo cleanup
    },
    ready() {
      this._readyDep.depend();
      return this._isReady;
    },
  };

  Meteor.apply(name, subscribeArgs, {}, (error, data) => {
    if (error) {
      onStop?.(error); // Original behavior when a subscription fails
      return removeSub(key);
    }

    subHandle._collectionNames = Object.keys(data);

    if (shouldCache) {
      addSub({ key, handle: subHandle, duration, active: true });
    } else {
      (seen[key] ??= {}).handle = subHandle;
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
