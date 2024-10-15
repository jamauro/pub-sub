import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { check } from 'meteor/check';
import { EJSON } from 'meteor/ejson';
import { formatId, convertFilter, removeValue, overrideLowLevelPublishAPI, mergeDocIntoFetchResult } from './utils/server';
import { isEmpty } from './utils/shared';

function addPublicationName(name, type) {
  Meteor.settings.public.packages ||= {};
  Meteor.settings.public.packages['jam:pub-sub'] ||= {};
  Meteor.settings.public.packages['jam:pub-sub'].pubs ||= {};

  return (Meteor.settings.public.packages['jam:pub-sub'].pubs[type] ||= []).push(name);
}

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
  const processCursor = async cursor => {
    const { collectionName, selector, options: { projection } } = cursor._cursorDescription;
    result[collectionName] = { selector, projection, docs: await cursor.fetchAsync() };
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
const streamsCache = new Map();

const operations = {
  insert: (methods, collectionName, doc) => doc.fullDocument && methods.added(collectionName, formatId(doc.documentKey._id), doc.fullDocument),
  replace: (methods, collectionName, doc) => doc.fullDocument && methods.changed(collectionName, formatId(doc.documentKey._id), doc.fullDocument),
  delete: (methods, collectionName, doc) => methods.removed(collectionName, formatId(doc.documentKey._id)),
  update: (methods, collectionName, doc) => {
    const { updatedFields, removedFields } = doc.updateDescription;
    for (const item of removedFields) {
      updatedFields[item] = undefined;
    }

    return methods.changed(collectionName, formatId(doc.documentKey._id), updatedFields);
  },
  drop: (methods) => methods.stop(),
  dropDatabase: (methods) => methods.stop(),
  rename: (methods) => methods.stop(),
  invalidate: (methods) => methods.stop(),
};

const handleChangeStreamEvents = async (key, collectionName, doc) => {
  const operation = operations[doc.operationType];
  if (!operation) return;

  const { subs } = streamsCache.get(key);
  const rawCollection = MongoInternals.defaultRemoteCollectionDriver().mongo.db.collection(collectionName);
  const addedDocs = new Map();

  const promises = [...subs.values()].map(async methods => {
    try {
      return operation(methods, collectionName, doc);
    } catch (error) {
      if (error.message.includes('Could not find element')) { // this should only happen if the user happens to refresh their page and a doc that was part of a .stream subscription is moved to a .once subscription and then back
        const docId = formatId(doc.documentKey._id);
        const cachedDoc = addedDocs.get(docId);
        const fullDoc = cachedDoc || await rawCollection.findOne({ _id: docId });

        if (!addedDocs.has(docId)) {
          addedDocs.set(docId, fullDoc);
        }

        return methods.added(collectionName, docId, fullDoc);
      }

      throw error;
    }
  });

  const results = await Promise.allSettled(promises);
  const rejected = results.filter(r => r.status === 'rejected');
  if (rejected.length) {
    console.error('Change Streams Event handling failed', rejected)
  }

  return addedDocs.clear();
};

function setupChangeStream(subId, methods, collectionName, filter, projection) {
  const key = EJSON.stringify({ collectionName, filter });

  // check if a change stream already exists for the given match filter and, if so, reuse it
  const cachedStream = streamsCache.get(key);
  if (cachedStream) {
    if (!cachedStream.subs.has(subId)) {
      cachedStream.subs.set(subId, methods);
    }

    return subId;
  }

  const match = isEmpty(filter) ? {} : { $or: [
    convertFilter(filter),
    { 'updateDescription': { '$exists': true } },
    { 'operationType': 'delete' }
  ]};

  const project = {};
  for (const key in projection) {
    project[`fullDocument.${key}`] = projection[key];
  }

  const pipeline = [{ $match: match }, ...(isEmpty(project) ? [] : [{ $project: project }])];
  const rawCollection = MongoInternals.defaultRemoteCollectionDriver().mongo.db.collection(collectionName);
  const changeStream = rawCollection.watch(pipeline);

  changeStream.on('change', doc => handleChangeStreamEvents(key, collectionName, doc));

  const subs = new Map();
  subs.set(subId, methods);
  streamsCache.set(key, { stream: changeStream, subs });
  return subId;
}

function releaseChangeStream(subId, collectionName, filter) {
  const key = EJSON.stringify({ collectionName, filter });

  const cachedStream = streamsCache.get(key);

  if (!cachedStream) return;

  cachedStream.subs.delete(subId);
  if (cachedStream.subs.size === 0) {
    cachedStream.stream.close();
    streamsCache.delete(key);
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
    const stops = [];

    const methods = { // we will cache these so we can call them later when the change stream sends a 'change' event
      added: (...args) => sub.added(...args),
      changed: (...args) => sub.changed(...args),
      removed: (...args) => sub.removed(...args),
      stop: () => sub.stop(),
    };

    const results = await fetchData(sub, handler, args);

    for (const [ collectionName, { selector, projection, docs } ] of Object.entries(results)) {
      for (doc of docs) {
        sub.added(collectionName, doc._id, doc);
      }

      const finalSelector = removeValue(selector, this.userId); // we remove userId from a change stream selector since using it won't scale – it'll end up creating too many unique change streams

      if (Meteor.isDevelopment && isEmpty(finalSelector)) {
        console.warn(`Your change stream for ${name} will be observing the entire ${collectionName} collection. This likely won't scale well. It's recommended to update your selector.`)
      }

      setupChangeStream(sub._subscriptionId, methods, collectionName, finalSelector, projection);

      stops.push(() => releaseChangeStream(sub._subscriptionId, collectionName, finalSelector));
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
