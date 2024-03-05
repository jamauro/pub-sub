const isEmpty = obj => [Object, Array].includes((obj || {}).constructor) && !Object.entries((obj || {})).length;
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
    } else if (isObject(lastArg)) {
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


export const mergeIntoMinimongo = (data, sub) => {
  if (!isObject(data)) return;

  const dataEntries = Object.entries(data);

  // Prevent the UI from flashing when updating
  dataEntries.forEach(([collectionName]) => {
    Meteor.connection._mongo_livedata_collections[collectionName]?.pauseObservers();
  });

  // Populate the fetched data into Minimongo
  dataEntries.forEach(([collectionName, docs]) => {
    const store = Meteor.connection._stores[collectionName];
    const localCollection = Meteor.connection._mongo_livedata_collections[collectionName];

    if (!store || !localCollection || isEmpty(docs)) return;

    docs.forEach(doc => {
      const existingDoc = localCollection._docs.get(doc._id);

      if (existingDoc) {
        Object.assign(existingDoc, { __sub: sub });
        localCollection.update(doc._id, merge(existingDoc, doc));
      } else {
        Object.assign(doc, { __sub: sub });
        localCollection.insert(doc);
      }
    });

    // Prevent this data from being reset on reconnect
    if (!store.__PubSub__mergedWithNonreactiveData) {
      store.beginUpdate = function (batchSize) {
        if (batchSize > 1) localCollection.pauseObservers();
        return;
      };
      store.__PubSub__mergedWithNonreactiveData = true;
    }
  });

  // Resume UI reactivity
  dataEntries.forEach(([collectionName]) => {
    Meteor.connection._mongo_livedata_collections[collectionName]?.[Meteor.isFibersDisabled ? 'resumeObserversClient' : 'resumeObservers']?.();
  });

  return;
};

export const removeFromMinimongo = (collectionNames, sub) => {
  collectionNames.forEach(collectionName => {
    const store = Meteor.connection._stores[collectionName];
    const localCollection = Meteor.connection._mongo_livedata_collections[collectionName];

    if (!store || !localCollection) return;

    localCollection.remove({__sub: sub});

    // Prevent this data from being reset on reconnect
    if (!store.__PubSub__mergedWithNonreactiveData) {
      store.beginUpdate = function (batchSize) {
        if (batchSize > 1) localCollection.pauseObservers();
        return;
      };
      store.__PubSub__mergedWithNonreactiveData = true;
    }
  });

  return;
};
