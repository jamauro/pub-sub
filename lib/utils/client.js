import { isEmpty } from './shared';

const isObject = o => o && o.constructor === Object;
const isFunction = f => typeof f === 'function';

// replaces lodash merge
export function merge(source, target) {
  for (const [key, val] of Object.entries(source)) {
    if (val !== null && typeof val === `object`) {
      target[key] ??=new val.__proto__.constructor();
      merge(val, target[key]);
    } else {
      target[key] = val;
    }
  }

  return target; // we're replacing in-situ, so this is more for chaining than anything else
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

export const createIdMap = (collectionNames, filter) => {
  const ids = {};
  const collections = Meteor.connection._mongo_livedata_collections;
  for (const collectionName of collectionNames) {
    ids[collectionName] = collections[collectionName].find(filter).map(d => d._id);
  }
  return ids;
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
      const finalDoc = existingDoc ? merge(existingDoc, doc) : doc;
      if (!existingDoc || existingDoc.__subs) {
        // If there's already an existing document from a regular publication (no __subs), 
        // don't do this, so we don't remove it from Minimongo later.
        finalDoc.__subs = finalDoc.__subs ? [...new Set([...finalDoc.__subs, sub])] : [sub];
      }
      existingDoc ? localCollection.update(doc._id, finalDoc) : localCollection.insert(finalDoc);
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

  for (const collectionName of collectionNames || []) {
    const store = stores[collectionName];
    const localCollection = collections[collectionName];

    if (!store || !localCollection) continue;
    localCollection.remove({__subs: [sub]});
    localCollection.update({}, { $pull: { __subs: sub } }, { multi: true });

    // Prevent this data from being reset on reconnect
    preventDataReset(store, localCollection);
  };

  return;
};
