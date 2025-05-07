/*
  server-side caching for .stream(s)

  if a limit is set, we'll only store the inital set of docs for the limit to reduce memory usage
  we keep this set of docs up to date using change streams
  if a client requests more docs, those will be fetched and sent to them but not stored in the cache
*/

import { Meteor } from 'meteor/meteor';
import { MongoInternals } from 'meteor/mongo';
import { DDPServer } from 'meteor/ddp-server';
import { Random } from 'meteor/random';
import { config } from './config';
import { createKey, parseKey } from './utils/shared';
import { matchesFilter, formatId, trim } from './utils/server';

const documents = new Map(); // collectionName -> Map(_id -> document)
const caches = new Map(); // key -> { _id: unique ref, docIds: Set of _ids, timestamps: Map(timestamp -> Set of subIds), metadata, limit?, skip? }
const REFS = Symbol('refs'); // used to associate a single document with mutiple cache key reference _ids

const operations = {
  insert: (key, doc) => set(key, [doc]),
  replace: (key, doc) => set(key, [doc]),
  delete: (key, doc) => removeDocument(key, doc._id),
  update: async (key, doc) => {
    const { collectionName, docs, filter } = get(key);
    const existingDoc = docs.find(d => d._id === doc._id);

    if (existingDoc) {
      const updatedDoc = { ...existingDoc, ...doc };

      if (!matchesFilter(updatedDoc, filter)) {
        return removeDocument(key, doc._id);
      }

      return set(key, [updatedDoc]);
    }

    // we didn't find it in the cache. let's try to find and add it.
    try {
      const rawCollection = MongoInternals.defaultRemoteCollectionDriver().mongo.db.collection(collectionName);
      const foundDoc = await rawCollection.findOne({ _id: doc._id });
      if (!foundDoc || !matchesFilter(foundDoc, filter)) {
        return;
      }

      set(key, [foundDoc]);

      return foundDoc;
    } catch (error) {
      if (config.debug) console.error(`[jam:pub-sub] Error while updating Cache, purging for key ${key}`);
      deleteKey(key);
      throw error;
    }
  }
};

function createEntry(key, { sort, skip, limit } = {}) {
  const metadata = parseKey(key);

  const entry = { // to minimize memory usage and only keep the initial set of docs for the .stream, we only store the initial limit / skip
    _id: Random.id(),
    docIds: new Set(),
    timestamps: new Map(),
    ...metadata,
    ...(sort && { sort }),
    ...(skip && { skip }),
    ...(limit && { limit })
  };

  caches.set(key, entry);
  return entry;
}

function get(key, { skip, limit } = {}) {
  if (config.serverState === 'none') return;

  const entry = caches.get(key) || createEntry(key, { skip, limit });

  if (skip && skip !== 0) { // pagination with a skip
    entry.docs = [];
    return entry;
  }

  const { _id, collectionName, docIds, filter, sort, ...rest } = entry;
  const cachedDocs = getDocumentsByIds(collectionName, docIds);

  if (!cachedDocs.length && sort) { // handle a potential flip in the sort direction avoids trying to findExistingDocs that won't exist
    entry.docs = [];
    return entry;
  }

  const docs = cachedDocs.length ? cachedDocs : findExistingDocs({ collectionName, filter, sort, skip, limit }); // findExistingDocs looks for the document elsewhere in the documents Map

  for (const doc of docs) {
    doc[REFS].add(_id);
    docIds.add(doc._id);
  }

  entry.docs = docs;
  return entry;
}

function set(key, docs) {
  if (config.serverState === 'none') return;
  if (!docs.length) return;

  const entry = caches.get(key);
  if (!entry) return;

  const { _id, docIds, collectionName, filter, sort } = entry;

  if (!documents.has(collectionName)) {
    documents.set(collectionName, new Map());
  }

  const cachedDocs = documents.get(collectionName);

  for (const doc of docs) {
    if (!doc._id) continue;

    doc._id = formatId(doc._id);
    (doc[REFS] ||= new Set()).add(_id); // a document could belong to multiple streams at a given time, we track them here

    cachedDocs.set(doc._id, doc);
    docIds.add(doc._id);
  }

  enforceLimits(entry);
  return;
}

async function update(key, doc, operationType) {
  if (config.serverState === 'none') return;

  const operation = operations[operationType];
  if (!operation) return;

  const entry = caches.get(key);
  if (!entry) return;

  const everyone = entry.docIds.has(doc._id);
  const result = await operation(key, doc);

  return {
    entry,
    ...(operationType === 'delete' && { everyone }),
    ...(operationType === 'update' && { fullDoc: result })
  };
}

function deleteKey(key) {
  const entry = caches.get(key);
  if (!entry) return;

  const { docIds } = entry;

  for (const docId of docIds) {
    removeDocumentByEntry(entry, docId);
  }

  caches.delete(key);
  return;
}

function getDocumentsByIds(collectionName, ids) {
  const collectionDocs = documents.get(collectionName);
  return [...ids].map(id => collectionDocs?.get(id)).filter(Boolean);
}

export function findExistingDocs({ collectionName, filter, sort, skip, limit }) { // exported for testing
  if (Object.keys(filter).length !== 1 || !filter._id || filter._id?.$nin) { // we're only matching on _id value and $in for now
    return [];
  }

  const collectionDocs = [...(documents.get(collectionName)?.values() || [])];
  if (!collectionDocs.length) return [];

  if (sort) {
    const [field, direction] = Object.entries(sort)[0];
    collectionDocs.sort((a, b) => direction * ((a[field] || 0) - (b[field] || 0)));
  }

  const existingDocs = limit ? trim(collectionDocs, skip, limit) : collectionDocs;
  const foundDocs = [];

  for (const doc of existingDocs) {
    if (matchesFilter(doc, filter)) {
      foundDocs.push(doc);
    }
  }

  if (limit > foundDocs.length) {
    return []; // force a fetch from the db
  }

  return foundDocs;
}

function enforceLimits(entry) {
  const { collectionName, docIds, sort, limit } = entry;
  if (!limit || docIds.size <= limit) return;

  const docs = getDocumentsByIds(collectionName, docIds);

  if (sort) {
    const [field, direction] = Object.entries(sort)[0];
    docs.sort((a, b) => direction * ((a[field] || 0) - (b[field] || 0)));
    docs.slice(limit).forEach(doc => removeDocumentByEntry(entry, doc._id));
  } else {
    [...docIds].slice(docIds.size - limit).forEach(id => removeDocumentByEntry(entry, id));
  }

  return;
}

function removeDocument(key, docId) {
  const entry = caches.get(key);
  if (!entry) return;

  return removeDocumentByEntry(entry, docId);
}

function removeDocumentByEntry(entry, docId) {
  const { _id, docIds, collectionName } = entry;

  docIds.delete(docId);

  const collectionDocs = documents.get(collectionName);
  if (!collectionDocs) return;

  const doc = collectionDocs.get(docId);
  if (!doc) return;

  doc[REFS].delete(_id);

  if (!doc[REFS].size) collectionDocs.delete(docId);
  if (collectionDocs.size === 0) {
    documents.delete(collectionName);
  }

  return;
}

function removeTimestamp(timestamps, subId) {
  for (const [timestamp, subIds] of timestamps.entries()) { // we want the subId to be associated with one timestamp max
    if (subIds.has(subId)) {
      subIds.delete(subId);

      if (!subIds.size) {
        timestamps.delete(timestamp);
      }
    }
  }

  return;
}

function clearTimestamp(key, subId) {
  const { timestamps } = caches.get(key);
  return removeTimestamp(timestamps, subId);
}

function setTimestamp(key, subId, doc) {
  const { timestamps, sort } = caches.get(key);
  const [[ field, direction] = [] ] = Object.entries(sort || {});

  removeTimestamp(timestamps, subId);

  const timestamp = doc[field].toISOString();

  let set = timestamps.get(timestamp);
  if (!set) {
    set = new Set();
    timestamps.set(timestamp, set);
  }
  set.add(subId);

  return;
}

export const clearCache = () => {
  documents.clear();
  caches.clear();
  return;
};

export const Cache = {
  get,
  set,
  update,
  delete: deleteKey,
  clear: clearCache,
  setTimestamp,
  clearTimestamp
};

// serverState is used to control publication strategies
Meteor.startup(() => {
  const { serverState, debug } = config;
  if (serverState === 'standard') return; // standard means the Meteor default which is keeping all state for every connected client + 1 for mergebox

  const { NO_MERGE_NO_HISTORY, NO_MERGE } = DDPServer.publicationStrategies;
  const disableMergeBox = serverState === 'none';
  const publishNames = Object.keys( Meteor.server.publish_handlers).filter(k => !k.includes('meteor'));
  const pubs = Meteor.settings.public?.packages?.['jam:pub-sub']?.pubs;
  const streamNames = pubs?.stream || [];
  const excludedCollections = ['users', 'roles']; // we might lift this restriction in the future but seems like a wise choice to exclude them for now, aka make sure they use the Meteor default for server state
  const collectionNames = [...Mongo._collections.keys()].filter(k => !excludedCollections.includes(k));

  for (const name of collectionNames) {
    const regPubs = publishNames.filter(n => n.includes(name))
    const streamPubs = streamNames.filter(p => p.includes(name))
    const canDisable = streamPubs.length && regPubs.length === streamPubs.length && regPubs.every(n => streamPubs.includes(n))

    if (disableMergeBox || canDisable) { // we attempt to disable mergebox when we're using .stream. we prioritize server resources (RAM and CPU) over a potential increase in bandwidth. In practice, the bandwidth increase could be low to possibly none.
      if (debug) console.info(`[jam:pub-sub] ${name} - disabling mergebox, aka NO_MERGE_NO_HISTORY`);
      Meteor.server.setPublicationStrategy(name, NO_MERGE_NO_HISTORY);
      continue;
    }

    // staying true to the Meteor docs "This strategy can be used when a collection is only used in a single publication" https://docs.meteor.com/api/meteor.html#no-merge
    if (serverState === 'minimal' && regPubs.filter(p => !streamPubs.includes(p)).length === 1) {
      if (debug) console.info(`[jam:pub-sub] ${name} - setting NO_MERGE` );
      Meteor.server.setPublicationStrategy(name, NO_MERGE);
    }
  }
});
