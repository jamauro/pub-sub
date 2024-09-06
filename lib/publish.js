import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { check } from 'meteor/check';
import { EJSON } from 'meteor/ejson';
import { convertFilter, overrideLowLevelPublishAPI, mergeDocIntoFetchResult } from './utils/server';
import { isEmpty } from './utils/shared';

function addPublicationName(name, type) {
  Meteor.settings.public.packages ||= {};
  Meteor.settings.public.packages['jam:pub-sub'] ||= {};
  Meteor.settings.public.packages['jam:pub-sub'].pubs ||= {};

  return (Meteor.settings.public.packages['jam:pub-sub'].pubs[type] ||= []).push(name);
}

// self is the publication context when using .stream and the method context when using .once
async function fetchData(self, handler, args) {
  const result = {};
  const handlerReturn = await handler.apply(self, args);

  const isSingleCursor = handlerReturn && handlerReturn._publishCursor;
  const isArrayOfCursors = Array.isArray(handlerReturn) && handlerReturn.every(cursor => cursor._publishCursor);

  // Validate the cursor(s)
  if (handlerReturn && !isSingleCursor && !isArrayOfCursors) {
    throw new Error(`Handler for '${self.name}' returns invalid cursor(s).`);
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
      throw new Error(`Handler for '${self.name}' returns an array containing cursors of the same collection.`);
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
    [name]: async function (...args) {
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

const formatId = id => typeof id === 'object' ? new MongoID.ObjectID(id.toString()) : id; // support for Mongo ObjectId

const operations = {
  insert: (self, collectionName, doc) => doc.fullDocument && self.added(collectionName, formatId(doc.documentKey._id), doc.fullDocument),
  replace: (self, collectionName, doc) => doc.fullDocument && self.changed(collectionName, formatId(doc.documentKey._id), doc.fullDocument),
  delete: (self, collectionName, doc) => self.removed(collectionName, formatId(doc.documentKey._id)),
  update: (self, collectionName, doc) => {
    const { updatedFields, removedFields } = doc.updateDescription;
    for (const item of removedFields) {
      updatedFields[item] = undefined;
    }
    self.changed(collectionName, formatId(doc.documentKey._id), updatedFields);
  },
  drop: (self) => self.stop(),
  dropDatabase: (self) => self.stop(),
  rename: (self) => self.stop(),
  invalidate: (self) => self.stop(),
};

const handleChangeStreamEvents = (self, collectionName, doc) => {
  const operation = operations[doc.operationType];
  return operation && operation(self, collectionName, doc);
};

function getChangeStream(collectionName, filter, projection) {
  const key = EJSON.stringify({ collectionName, filter });

  // check if a change stream already exists for the given match filter and, if so, reuse it
  const cachedStream = streamsCache.get(key);
  if (cachedStream) {
    cachedStream.count++;
    return cachedStream.stream;
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

  streamsCache.set(key, { stream: changeStream, count: 1 });
  return changeStream;
}

function releaseChangeStream(collectionName, filter) {
  const key = EJSON.stringify({ collectionName, filter });

  const cachedStream = streamsCache.get(key);
  if (!cachedStream) return;

  cachedStream.count--;
  if (cachedStream.count === 0) {
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

  Meteor.publish(name, async function (...args) {
    const stops = [];

    const results = await fetchData(this, handler, args);

    for (const [collectionName, { selector, projection, docs }] of Object.entries(results)) {
      for (doc of docs) {
        this.added(collectionName, doc._id, doc);
      }

      const changeStream = getChangeStream(collectionName, selector, projection);

      changeStream?.on('change', doc => {
        handleChangeStreamEvents(this, collectionName, doc);
      });

      stops.push(() => releaseChangeStream(collectionName, selector));
    }

    this.ready();

    this.onStop(() => {
      for (stop of stops) { stop() }
    });

    return;
  });

  return;
}

Meteor.publish.once = publishOnce;
Meteor.publishOnce = publishOnce;
Meteor.publish.stream = stream;
Meteor.publishStream = publishStream;
