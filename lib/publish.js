import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { check } from 'meteor/check';
import { Cache } from './cache';
import { config } from './config';
import { actions } from './mongo';
import { getCursor, formatId, convertFilter, removeValue, overrideLowLevelPublishAPI, mergeDocIntoFetchResult } from './utils/server';
import { isEmpty, createKey } from './utils/shared';

let onces = [];
Meteor.startup(() => {
  const all = Meteor.settings.public.packages?.['jam:pub-sub']?.pubs || {};
  onces = all.once || [];
});

function addPublicationName(name, type) {
  Meteor.settings.public.packages ||= {};
  Meteor.settings.public.packages['jam:pub-sub'] ||= {};
  Meteor.settings.public.packages['jam:pub-sub'].pubs ||= {};

  return (Meteor.settings.public.packages['jam:pub-sub'].pubs[type] ||= []).push(name);
}

const streamsCache = new Map(); // key -> { stream: changeStream, subs: Map(subId -> { methods, sessionId } ) }

// context is the publication context when using .stream and the method context when using .once
async function fetchData(context, handler, args) {
  const result = {};
  const handlerReturn = await handler.apply(context, args);

  const isSingleCursor = handlerReturn && handlerReturn._publishCursor;
  const isArrayOfCursors = Array.isArray(handlerReturn) && handlerReturn.every(cursor => cursor._publishCursor);

  // Validate the cursor(s)
  if (handlerReturn && !isSingleCursor && !isArrayOfCursors) {
    throw new Error(`Handler for '${context.name}' returns invalid cursor(s).`);
  }

  if (!isSingleCursor && !isArrayOfCursors) {
    // no-op: The original publish handler didn't return any cursor. This may
    // happen when, for example, a certain authentication check fails and the
    // handler exits early with this.ready() called to signal an empty publication.
    // In this case we simply return the result as an empty object.
    return result;
  }

  if (isArrayOfCursors) {
    const collectionNames = handlerReturn.map(cursor => cursor._cursorDescription.collectionName);
    const hasDuplicatedCollections = new Set(collectionNames).size !== collectionNames.length;
    // This rule is enforced in the original publish() function
    if (hasDuplicatedCollections)
      throw new Error(`Handler for '${context.name}' returns an array containing cursors of the same collection.`);
  }

  // Fetch the cursor(s)
  const cursors = isSingleCursor ? [handlerReturn] : handlerReturn;
  const isSub = context.constructor.name === 'Subscription';
  const shouldCache = isSub && config.serverState !== 'none';

  const processCursor = async c => {
    const { cursor, collectionName, filter, update, options: { projection, sort, skip, limit } } = getCursor(c, args);

    if (!shouldCache) { // we don't cache the docs on the server if they are fetched via .once
      const docs = await cursor.fetchAsync();
      return result[collectionName] = { filter, projection, docs };
    }

    const key = createKey({ collectionName, filter, sort });
    const { docs: cachedDocs } = Cache.get(key, { skip, limit });
    const hasCache = !update && cachedDocs.length;
    const docs = hasCache ? cachedDocs : await cursor.fetchAsync();

    if (!hasCache) { // we only cache the initial result set and then keep it updated with the change stream so we avoid keep a ton of data on the server and expending resources
      Cache.set(key, docs);
    }

    if (update && sort && docs.length) {
      const subId = context._subscriptionId;
      Cache.setTimestamp(key, subId, docs.at(-1));
    }

    return result[collectionName] = { filter, projection, docs, key };
  };

  await Promise.all(cursors.map(processCursor));

  return result;
}

/**
 * Publishes a record set once.
 * @param {string} name - The name of the event to publish.
 * @param {Function} handler - The function called on the server each time a client subscribes.
 * @returns {Object.<string, Array.<Object>>} An object containing arrays of documents for each collection. These will be autmatically merged into Minimongo.
 */
function publishOnce(name, handler) {
  check(name, String);
  check(handler, Function);

  if (name === null) {
    throw new Error('You should use Meteor.publish() for null publications.');
  }
  if (Meteor.server.method_handlers[name]) {
    throw new Error(`Cannot create a method named '${name}' because it has already been defined.`);
  }

  addPublicationName(name, 'once');

  Meteor.methods({
    [name]: async function(...args) {
      const customAddedDocuments = [];

      overrideLowLevelPublishAPI(this, customAddedDocuments);

      const result = await fetchData(this, handler, args);

      for (const doc of customAddedDocuments) {
        mergeDocIntoFetchResult(doc, result);
      }

      return result;
    }
  });
};

// change streams
const formatDoc = streamDoc => {
  const _id = formatId(streamDoc.documentKey._id);
  const doc = streamDoc.fullDocument || {};
  doc._id = _id;

  if (streamDoc.operationType !== 'update') {
    return doc;
  }

  const { updatedFields, removedFields } = streamDoc.updateDescription || {};
  for (const item of removedFields) {
    updatedFields[item] = undefined;
  }

  return Object.assign(doc, updatedFields);
};

const operations = {
  insert: ({ methods, collectionName, doc }) => methods.added(collectionName, doc._id, doc),
  replace: ({ methods, collectionName, doc }) => methods.changed(collectionName, doc._id, doc),
  delete: ({ methods, collectionName, doc }) => methods.removed(collectionName, doc._id),
  update: ({ methods, collectionName, doc }) => methods.changed(collectionName, doc._id, doc),
  drop: ({ methods }) => methods.stop(),
  dropDatabase: ({ methods }) => methods.stop(),
  rename: ({ methods }) => methods.stop(),
  invalidate: ({ methods }) => methods.stop(),
};

const deletes = new Map(); // used to queue deleted docs, if there's a bulk delete, they'll come through in rapid succession and we need to know how many were deleted so we can try to fill in the next ones in handleDelete
const THRESHOLD = 100;

async function queueDelete({ cacheKey, subs, entry, everyone }) {
  const timeout = setTimeout(() => {
    const { count } = deletes.get(cacheKey) || {};
    deletes.delete(cacheKey);
    return handleDelete({ cacheKey, subs, entry, everyone, count });
  }, THRESHOLD);

  const existing = deletes.get(cacheKey);

  if (existing) {
    clearTimeout(existing.timeout);
    existing.count++
    return;
  }

  return deletes.set(cacheKey, { timeout, count: 1 });
}

async function handleDelete({ cacheKey, subs, entry, everyone, count }) { // we try to fill in the next doc(s) after a delete occurs. this behavior mimics traditional pub/sub.
  try {
    const { collectionName, filter, sort, docIds, timestamps } = entry;
    const rawCollection = MongoInternals.defaultRemoteCollectionDriver().mongo.db.collection(collectionName);
    const individuals = new Set();
    const limit = count || 1;

    if (timestamps.size && sort) {
      const [field, direction] = Object.entries(sort)[0];
      const operator = direction === -1 ? '$lt' : '$gt';
      const updates = new Map();

      for (const [timestamp, subIds] of timestamps.entries()) {
        for (const subId of subIds) {
          individuals.add(subId);
        }

        const query = { ...filter, [field]: {[operator]: new Date(timestamp)} }
        const foundDocs = await rawCollection.find(query, { sort, limit }).toArray() || [];
        if (!foundDocs.length) continue;

        for (const subId of subIds) {
          const { methods } = subs.get(subId);
          if (!methods) continue;

          for (const foundDoc of foundDocs) {
            methods.added(collectionName, foundDoc._id, foundDoc)
          }

          updates.set(subId, foundDocs.at(-1)); // we can't mutate timestamps directly above so we process them below. we're mutating as an optimization for memory
        }
      }

      for (const [subId, doc] of updates.entries()) {
        Cache.setTimestamp(cacheKey, subId, doc);
      }
    }

    if (everyone) {
      const query = { ...filter, _id: {$nin: [...docIds]} };
      const foundDocs = await rawCollection.find(query, { sort, limit }).toArray() || [];
      if (!foundDocs.length) return;

      Cache.set(cacheKey, foundDocs);

      for (const [subId, { methods }] of subs) {
        if (individuals.has(subId)) continue;

        for (const foundDoc of foundDocs) {
          methods.added(collectionName, foundDoc._id, foundDoc);
        }
      }
    }

    return;
  } catch (error) {
    if (config.debug) console.error(`[jam:pub-sub] Error in handleDelete, purging Cache for key ${cacheKey}`, error);
    Cache.delete(cacheKey);
  }
}

async function handleChangeStreamEvents(key, streamDoc, cacheKey) {
  const { operationType, ns: { coll: collectionName } } = streamDoc;
  const operation = operations[operationType];
  if (!operation) return;

  const { subs } = streamsCache.get(key);
  const rawCollection = MongoInternals.defaultRemoteCollectionDriver().mongo.db.collection(collectionName);
  const doc = formatDoc(streamDoc);
  const actorSessionIds = actions.get(doc._id);
  const addedDocs = new Map();

  const { entry, everyone, fullDoc } = await Cache.update(cacheKey, doc, operationType); // for an 'update' operationType, fullDoc was fetched from the db because it wasn't found in the Cache initially. we need to send it instead of just the fields that were updated so the client receives all fields.

  const promises = [...subs].map(async ([subId, { methods, sessionId }]) => {
    try {
      const isActor = actorSessionIds?.has(sessionId);
      if (isActor) actorSessionIds.delete(sessionId);

      const broadcast = !isActor || !['insert', 'update', 'replace', 'delete'].includes(operationType); // we avoid broadcasting to teh actor. they'll receive the ddp message via the logic in ./mongo
      if (!broadcast) return;

      return operation({ methods, collectionName, doc: fullDoc || doc });
    } catch (error) {
      if (error.message.includes('Could not find element')) { // this should only happen if the user happens to refresh their page and a doc that was part of a .stream subscription is moved to a .once subscription and then back

        const cachedDoc = addedDocs.get(doc._id);
        const fullDoc = cachedDoc || await rawCollection.findOne({ _id: doc._id });

        if (!addedDocs.has(doc._id)) {
          addedDocs.set(doc._id, fullDoc);
        }

        return methods.added(collectionName, doc._id, fullDoc);
      }

      throw error;
    }
  });

  if (operationType === 'delete') {
    promises.push(queueDelete({ cacheKey, subs, entry, everyone }));
  }

  const results = await Promise.allSettled(promises);

  const rejected = results.filter(r => r.status === 'rejected');
  if (rejected.length) {
    console.error('[jam:pub-sub] Change Streams Event handling failed', rejected)
  }

  if (!onces.some(o => o.includes(collectionName.toLowerCase()))) { // clean up actions when possible, there are no .once publications otherwise falls back to TTL, see ./mongo for more info
    actions.delete(doc._id)
  }

  return addedDocs.clear();
};

function setupChangeStream({ subId, sessionId, collectionName, methods, filter, projection, key, cacheKey }) {
  const defaults = { methods, sessionId };
  // check if a change stream already exists for the given match filter and, if so, reuse it
  const cachedStream = streamsCache.get(key);
  if (cachedStream) {
    if (!cachedStream.subs.has(subId)) {
      cachedStream.subs.set(subId, defaults);
    }

    return subId;
  }

  const match = isEmpty(filter) ? {} : { $or: [
    convertFilter(filter),
    { 'updateDescription': { '$exists': true } },
    { 'operationType': 'delete' }
  ]};

  const project = {};
  for (const p in projection) {
    project[`fullDocument.${p}`] = projection[p];
  }

  const pipeline = [{ $match: match }, ...(isEmpty(project) ? [] : [{ $project: project }])];
  const rawCollection = MongoInternals.defaultRemoteCollectionDriver().mongo.db.collection(collectionName);
  const changeStream = rawCollection.watch(pipeline);

  changeStream.on('change', doc => handleChangeStreamEvents(key, doc, cacheKey));

  const subs = new Map();
  subs.set(subId, defaults);
  streamsCache.set(key, { stream: changeStream, subs });

  return subId;
}

function releaseChangeStream({ subId, key, cacheKey }) {
  Cache.clearTimestamp(cacheKey, subId);

  const cachedStream = streamsCache.get(key);
  if (!cachedStream) return;

  cachedStream.subs.delete(subId);

  if (cachedStream.subs.size === 0) {
    cachedStream.stream.close();
    streamsCache.delete(key);
    Cache.delete(cacheKey);
  }

  return;
}

/**
 * Stream a record set.
 * @param name {string} name - Name of the record set.
 * @param {Function} handler - The function called on the server each time a client subscribes. Inside the function, `this` is the publish handler object. If the client passed arguments to
 * `subscribe`, the function is called with the same arguments.
 * @returns {void}
 */
function stream(name, handler) {
  check(name, String);
  check(handler, Function);

  if (name === null) {
    throw new Error('You should use Meteor.publish() for null publications.');
  }
  if (Meteor.server.publish_handlers[name]) {
    throw new Error(`Cannot create a method named '${name}' because it has already been defined.`);
  }

  addPublicationName(name, 'stream');

  Meteor.publish(name, async function(...args) {
    const sub = this;
    const { _subscriptionId: subId, _session: { id: sessionId } } = sub;
    const stops = [];

    const methods = { // we will cache these so we can call them later when the change stream sends a 'change' event
      added: (...args) => sub.added(...args),
      changed: (...args) => sub.changed(...args),
      removed: (...args) => sub.removed(...args),
      stop: () => sub.stop(),
    };

    const results = await fetchData(sub, handler, args);

    const collections = [];

    for (const [ collectionName, { filter: f, projection, docs, key: cacheKey } ] of Object.entries(results)) {

      for (doc of docs) {
        sub.added(collectionName, doc._id, doc);
      }

      collections.push(collectionName);

      const filter = removeValue(f, this.userId); // we remove userId from a change stream filter since using it won't scale – it'll end up creating too many unique change streams

      if (Meteor.isDevelopment && isEmpty(filter)) {
        console.warn(`Your change stream for ${name} will be observing the entire ${collectionName} collection. This likely won't scale well. Updating your filter is recommended.`)
      }

      const key = createKey({ collectionName, filter }); // key for the streamsCache

      setupChangeStream({ subId, sessionId, collectionName, methods, filter, projection, key, cacheKey });

      stops.push(() => releaseChangeStream({ subId, key, cacheKey }));
    }

    sub.ready();

    sub.onStop(() => {
      for (stop of stops) { stop() }
    });

    return;
  });

  return;
}

Meteor.publish.once = publishOnce;
Meteor.publish.stream = stream;
