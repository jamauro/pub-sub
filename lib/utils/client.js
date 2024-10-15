import { isEmpty } from './shared';

export const subs = Symbol('subs');
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const isObject = o => o && o.constructor === Object;
const isFunction = f => typeof f === 'function';
const isEqual = (a, b) => {
  if (a === b) return true;

  return a?.size === b?.size && a.isSubsetOf(b); // for Sets
}

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
  const stores = Meteor.connection._stores;
  const collections = Meteor.connection._mongo_livedata_collections;

  for (const collectionName of collectionNames) {
    const store = stores[collectionName];
    const localCollection = collections[collectionName];

    if (!store || !localCollection) continue;

    for (const [id, doc] of localCollection._docs._map) {
      const ids = doc[subs];
      if (!ids) continue;

      if (isEqual(ids, new Set([sub]))) {
        localCollection.remove(id);
      } else if (ids.has(sub)) {
        ids.delete(sub);
      }
    }

    // Prevent this data from being reset on reconnect
    preventDataReset(store, localCollection);
  }

  return;
};
