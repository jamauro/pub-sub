/*
  Send DDP notifications to client when insertAsync(), updateAsync(), upsertAsync(), or removeAsync() is called
  inside a Meteor method invocation. This allows client (the method caller) to
  be aware of mutation results and have Minimongo automatically updated without
  having to rely on traditional pub/sub.
*/

import { Mongo } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { DDP } from 'meteor/ddp-client';
import { includesOnly, createProjection, extractIds } from './utils/server';

const originalInsert = Mongo.Collection.prototype.insertAsync;
const originalUpdate = Mongo.Collection.prototype.updateAsync;
const originalUpsert = Mongo.Collection.prototype.upsertAsync;
const originalRemove = Mongo.Collection.prototype.removeAsync;

const getClientSession = () => {
  const currentMethod = DDP._CurrentMethodInvocation?.get();
  const clientSessionId = currentMethod?.connection?.id;
  const session = clientSessionId && Meteor.server.sessions.get(clientSessionId)

  return session;
};

let pubs = [];
Meteor.startup(() => {
  pubs = Object.values(Meteor.settings.public.packages?.['jam:pub-sub']?.pubs || {});
});

const shouldSendMutationUpdates = collectionName => pubs.some(p => p.some(name => name.toLowerCase().includes(collectionName.toLowerCase())));

Mongo.Collection.prototype.insertAsync = async function (doc) {
  const session = getClientSession();

  if (!session || !shouldSendMutationUpdates(this._name)) {
    return originalInsert.call(this, doc);
  }

  const _id = await originalInsert.call(this, doc);
  session.send({ msg: 'added', collection: this._name, id: MongoID.idStringify(_id), fields: doc }); // MongoID.idStringify is used to support Mongo ObjectID

  return _id;
};

Mongo.Collection.prototype.removeAsync = async function (selector) {
  const session = getClientSession();

  if (!session || !shouldSendMutationUpdates(this._name)) {
    return originalRemove.call(this, selector);
  }

  const filter = Mongo.Collection._rewriteSelector(selector); // using filter interchangeably with selector since it feels not great mutating selector
  const extractedIds = filter._id && extractIds(filter);
  const docIdsToBeRemoved = extractedIds?.length ? extractedIds : await this.find(filter, { fields: { _id: 1 }}).mapAsync(doc => doc._id);
  const numRemoved = await originalRemove.call(this, filter);

  if (docIdsToBeRemoved.length === numRemoved) {
    for (const id of docIdsToBeRemoved) {
      session.send({ msg: 'removed', id: MongoID.idStringify(id), collection: this._name })
    }
  } else if (numRemoved > 0) {
    // if some of the documents failed to remove, then only send 'removed' for the ones that were successfully removed
    const docIdsRemaining = new Set(await this.find(filter, { fields: { _id: 1 }}).map(doc => doc._id));
    for (const id of docIdsToBeRemoved) {
      if (!docIdsRemaining.has(id)) {
        session.send({ msg: 'removed', id: MongoID.idStringify(id), collection: this._name });
      }
    }
  }

  return numRemoved;
};

Mongo.Collection.prototype.updateAsync = async function (selector, modifier, options = {}) {
  const session = getClientSession();

  if (!session || !shouldSendMutationUpdates(this._name)) {
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

  const { insertedId, numberAffected, value } = result;
  if (result === 0 || value === null) {
    return 0;
  }

  if (insertedId && includesOnly(modifierKeys, ['$set', '$setOnInsert'])) { // it's an upsert and we have the data we need. if it's not a $set or $setOnInsert, then we look up the final result using the below else block
    const fields = isReplace ? modifier : { ...modifier.$set, ...modifier.$setOnInsert };
    session.send({ msg: 'added', id: MongoID.idStringify(insertedId), fields, collection: this._name });
  } else if (!isUpsertOrMulti) {
    const { _id, ...fields } = value;
    session.send({ msg: 'changed', id: MongoID.idStringify(_id), fields, collection: this._name });
  } else {
    const finalFilter = hasId ? filter : insertedId ? { _id: insertedId } : docIds ? {_id: numberAffected === 1 ? docIds[0] : {$in: docIds }} : undefined;
    const projection = finalFilter && createProjection(modifier);
    const items = finalFilter ? await rawCollection.find(finalFilter, projection).toArray() : [];

    for (const { _id, ...fields } of items) {
      session.send({ msg: insertedId ? 'added' : 'changed', id: MongoID.idStringify(_id), fields, collection: this._name });
    }
  }

  return numberAffected ? numberAffected : result.ok ?? result;
};

Mongo.Collection.prototype.upsertAsync = async function(selector, modifier, options = {}) {
  const session = getClientSession();

  if (!session || !shouldSendMutationUpdates(this._name)) {
    return originalUpsert.call(this, selector, modifier, {...options, _returnObject: true, upsert: true});
  }

  return this.updateAsync(selector, modifier, {...options, _returnObject: true, upsert: true});
}
