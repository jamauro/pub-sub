/*
  Send DDP notifications to client when insertAsync(), updateAsync(), upsertAsync(),
  or removeAsync() is called inside a Meteor method invocation. This allows the client
  (the method caller) to be aware of mutation results and have Minimongo automatically
  updated without having to rely on traditional pub/sub.
*/

import { Mongo } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { DDP } from 'meteor/ddp-client';
import { includesOnly, createProjection, extractIds } from './utils/server';

const originalInsert = Mongo.Collection.prototype.insertAsync;
const originalUpdate = Mongo.Collection.prototype.updateAsync;
const originalUpsert = Mongo.Collection.prototype.upsertAsync;
const originalRemove = Mongo.Collection.prototype.removeAsync;

let pubNames = [];
let streams = [];
Meteor.startup(() => {
  const all = Meteor.settings.public.packages?.['jam:pub-sub']?.pubs || {};
  pubNames = Object.values(all)[0] || [];
  streams = all.stream || [];
});

const shouldSendMutationUpdates = collectionName => pubNames.some(name => name.toLowerCase().includes(collectionName.toLowerCase()));
const hasStream = collectionName => streams.some(name => name.toLowerCase().includes(collectionName.toLowerCase()));

// actions are used to avoid broadcasting via .stream to the client that created the action
// we don't currently have a way to distinguish if they were created as only applicable to .stream, i.e.
// they could be created when a .once publication if you have overlapping .stream and .once on the same collection and they're active at the same time
// so we make sure to clear the actions at a minimum with a TTL and we delete inside the "change" event when possible
export const actions = new Map();
const TTL = 2000;
const addAction = (id, sessionId) => {
  let set;
  if (!actions.has(id)) {
    set = new Set();
    actions.set(id, set);
  } else {
    set = actions.get(id)
  }
  set.add(sessionId)

  if (set.size === 1) {
    setTimeout(() => {
      actions.delete(id);
    }, TTL);
  }

  return;
};
//

function send({ msg, collection, _id, fields }) {
  const clientSessionId = DDP._CurrentMethodInvocation?.get()?.connection?.id;
  const session = clientSessionId && Meteor.server.sessions.get(clientSessionId);
  if (!session) return;

  const id = MongoID.idStringify(_id); // MongoID.idStringify is used to support Mongo ObjectID
  session.send({ msg, collection, id, ...(fields && { fields }) })

  const hasActiveStream = hasStream(collection) && [...session._namedSubs.values()].some(s => streams.includes(s._name))
  if (hasActiveStream) {
    addAction(id, clientSessionId);
  }

  return;
}

Mongo.Collection.prototype.insertAsync = async function (doc, options = {}) {
  options = Meteor.isFibersDisabled || Package['jam:easy-schema'] ? options : undefined; // 2.x support

  if (!shouldSendMutationUpdates(this._name)) {
    return originalInsert.call(this, doc, options);
  }

  const _id = await originalInsert.call(this, doc, options);

  send({ msg: 'added', collection: this._name, _id, fields: doc });
  return _id;
};

Mongo.Collection.prototype.removeAsync = async function (selector, options = {}) {
  options = Meteor.isFibersDisabled || Package['jam:soft-delete'] ? options : undefined; // 2.x support

  if (!shouldSendMutationUpdates(this._name)) {
    return originalRemove.call(this, selector, options)
  }

  const filter = Mongo.Collection._rewriteSelector(selector); // using filter interchangeably with selector since it feels not great mutating selector
  const extractedIds = filter._id && extractIds(filter);
  const docIdsToBeRemoved = extractedIds?.length ? extractedIds : await this.find(filter, { fields: { _id: 1 }}).mapAsync(doc => doc._id);
  const numRemoved = await originalRemove.call(this, filter, options);

  if (docIdsToBeRemoved.length === numRemoved) {
    for (const _id of docIdsToBeRemoved) {
      send({ msg: 'removed', _id, collection: this._name })
    }
  } else if (numRemoved > 0) {
    // if some of the documents failed to remove, then only send 'removed' for the ones that were successfully removed
    const docIdsRemaining = new Set(await this.find(filter, { fields: { _id: 1 }}).mapAsync(doc => doc._id));
    for (const _id of docIdsToBeRemoved) {
      if (!docIdsRemaining.has(_id)) {
        send({ msg: 'removed', _id, collection: this._name });
      }
    }
  }

  return numRemoved;
};

Mongo.Collection.prototype.updateAsync = async function (selector, modifier, options = {}) {
  if (!shouldSendMutationUpdates(this._name)) {
    return originalUpdate.call(this, selector, modifier, options);
  }

  // options._returnObject allows us to get the insertedId if an upsert results in a new document
  if (options.upsert && !options._returnObject) {
    options._returnObject = true;
  }

  const rawCollection = this._collection.rawCollection();
  const isUpsertOrMulti = options.upsert || options.multi;
  const filter = isUpsertOrMulti ? selector : Mongo.Collection._rewriteSelector(selector); // if it's upsert or multi, it will run through the originalUpdate which will rewrite the selector so we avoid doing it twice here. using filter interchangeably with selector since it feels not great mutating selector
  const hasId = filter._id || typeof filter === 'string'; // typeof check here in case the selector is an upsert or multi and its using the shorthand _id
  let docIds;

  if (!hasId && isUpsertOrMulti) {
    docIds = options.upsert ? await rawCollection.find(filter, {projection: {_id: 1}, sort: {$natural: 1}}).map(d => d._id).toArray() : await rawCollection.distinct('_id', filter); // look up the documents before so that we can use their _ids below. we treat upsert differently because we need to predict which document will be updated using sort $natural.
  }

  const modifierKeys = Object.keys(modifier);
  const isReplace = !isUpsertOrMulti && modifierKeys.every(k => !k.includes('$'));

  const result = isUpsertOrMulti ? await originalUpdate.call(this, filter, modifier, options) : isReplace ? await rawCollection.findOneAndReplace(filter, modifier, {...options, returnDocument: 'after'}) : await rawCollection.findOneAndUpdate(filter, modifier, {...options, returnDocument: 'after'});
  const { insertedId, numberAffected, value } = result.numberAffected ? result : { value: result };

  if (result === 0 || numberAffected === 0 || value === null) {
    return 0;
  }

  if (insertedId && includesOnly(modifierKeys, ['$set', '$setOnInsert'])) { // it's an upsert and we have the data we need. if it's not a $set or $setOnInsert, then we look up the final result using the below else block
    const fields = isReplace ? modifier : { ...modifier.$set, ...modifier.$setOnInsert };
    send({ msg: insertedId ? 'added' : 'changed', _id: insertedId, fields, collection: this._name });
  } else if (!isUpsertOrMulti) {
    const { _id, ...fields } = value;
    send({ msg: 'changed', _id, fields, collection: this._name });
  } else {
    const finalFilter = hasId ? filter : insertedId ? { _id: insertedId } : docIds ? {_id: numberAffected === 1 ? docIds[0] : {$in: docIds }} : undefined;
    const projection = finalFilter && createProjection(modifier);
    const items = finalFilter ? await rawCollection.find(finalFilter, projection).toArray() : [];

    for (const { _id, ...fields } of items) {
      send({ msg: insertedId ? 'added' : 'changed', _id, fields, collection: this._name });
    }
  }

  return numberAffected ? numberAffected : result.ok ?? typeof result === 'number' ? result : 1;
};

Mongo.Collection.prototype.upsertAsync = async function(selector, modifier, options = {}) {
  if (!shouldSendMutationUpdates(this._name)) {
    return originalUpsert.call(this, selector, modifier, {...options, _returnObject: true, upsert: true});
  }

  return this.updateAsync(selector, modifier, {...options, _returnObject: true, upsert: true});
}
