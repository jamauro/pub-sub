import { Meteor } from 'meteor/meteor';
import { isEmpty, omit } from './shared';
import { subsCache } from '../subs-cache';

export const subs = Symbol('subs');
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const isObject = o => o && o.constructor === Object;

const OMITS = ['limit', 'skip', 'createdAt', 'updatedAt'];
const isRange = obj => Object.keys(obj || {}).some(k => ['createdAt', 'updatedAt'].includes(k)); // it's a range-based pagination
const isFunction = f => typeof f === 'function';

// Deep equal comparison for objects, arrays, Sets. Can also be used for strings, numbers, etc.
export const isEqual = (first, second) => {
  if (first === second) return true;
  if (typeof first !== typeof second) return false;

  // Check for Set
  if (first instanceof Set && second instanceof Set) {
    return first.size === second.size && first.isSubsetOf(second);
  }

  if (typeof first === 'object') {
    if (Array.isArray(first)) {
      return (
        Array.isArray(second) &&
        first.length === second.length &&
        first.every((item, index) => isEqual(item, second[index]))
      );
    }

    const keys = Object.keys(first);
    if (keys.length !== Object.keys(second).length) return false;
    return keys.every(key => isEqual(first[key], second[key]));
  }

  return false;
};

export const extractSubscribeArguments = args => {
  let options = {};

  if (args.length) {
    const lastArg = args[args.length - 1];

    if (isFunction(lastArg)) {
      options.onReady = args.pop();
    } else if (isObject(lastArg) && ([lastArg.onReady, lastArg.onStop].some(isFunction) || 'cache' in lastArg || 'cacheDuration' in lastArg)) {
      options = args.pop();
    }
  }

  return {
    args,
    onStop: options.onStop,
    onReady: options.onReady,
    cache: options.cache,
    cacheDuration: options.cacheDuration
  }
};

const preventDataReset = (store, localCollection) => {
  if (!store.__PubSub__mergedWithNonreactiveData) {
    store.beginUpdate = function (batchSize) {
      if (batchSize > 1) localCollection.pauseObservers();
      return;
    };
    store.__PubSub__mergedWithNonreactiveData = true;
  }

  return;
};

export const maybeSwitchSub = (name, params, collections, shouldCache) => {
  if (!shouldCache && !isRange(params[0])) return;

  const sub = Object.values(Meteor.connection._subscriptions).find(s => s.name === name && !s.inactive) || Object.values(subsCache).reverse().find(s => s.handle?.name === name && s.active)?.handle;
  if (!sub) return;

  if (!isEqual(omit(sub.params[0], OMITS), omit(params[0], OMITS))) { // OMITS are omitted because we need to see if the params other than those used for infinite scroll / pagination are the equal
    return;
  }

  const subId = sub.id || sub.subscriptionId;
  const localCollections = Meteor.connection._mongo_livedata_collections;

  for (const collection of collections) {
    const localCollection = localCollections[collection];
    if (!localCollection) continue;

    const docsMap = localCollection._docs._map;

    for (const [id, doc] of docsMap) {
      const ids = doc[subs];
      if (ids.has(subId)) continue;

      ids.clear();
      ids.add(subId);
    }
  }

  return;
};

export const mergeIntoMinimongo = (data, sub) => {
  if (!isObject(data)) return;

  const stores = Meteor.connection._stores;
  const collections = Meteor.connection._mongo_livedata_collections;

  for (const [collectionName, { docs }] of Object.entries(data)) {
    const store = stores[collectionName];
    const localCollection = collections[collectionName];

    if (!store || !localCollection || isEmpty(docs)) continue;

    // Prevent the UI from flashing when updating
    localCollection.pauseObservers();

    for (const doc of docs) {
      const existingDoc = localCollection._docs.get(doc._id);
      const finalDoc = existingDoc || doc;

      (finalDoc[subs] ||= new Set()).add(sub);

      if (!existingDoc) localCollection.insert(finalDoc);
      localCollection._docs.set(doc._id, finalDoc);
    }

    // Prevent this data from being reset on reconnect
    preventDataReset(store, localCollection);

    // Resume UI reactivity
    localCollection[Meteor.isFibersDisabled ? 'resumeObserversClient' : 'resumeObservers']();
  }
};

export const removeFromMinimongo = (collectionNames, sub) => {
  if (!collectionNames.length) return;

  const stores = Meteor.connection._stores;
  const collections = Meteor.connection._mongo_livedata_collections;
  const currentUserId = Meteor.userId?.();

  for (const collectionName of collectionNames) {
    const store = stores[collectionName];
    const localCollection = collections[collectionName];

    if (!store || !localCollection) continue;

    const docsMap = localCollection._docs._map;
    const isUsersCollection = collectionName === 'users';

    for (const [id, doc] of docsMap) {
      if (isUsersCollection && id === currentUserId) continue; // prevent removing the current user

      const ids = doc[subs];
      if (!ids) continue;

      if (isEqual(ids, new Set([sub]))) {
        docsMap.delete(id);
      } else if (ids.has(sub)) {
        ids.delete(sub);
      }
    }

    // Prevent this data from being reset on reconnect
    preventDataReset(store, localCollection);
  }

  return;
};
