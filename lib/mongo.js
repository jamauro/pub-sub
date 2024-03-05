/*
  Send DDP notifications to client when insertAsync(), updateAsync(), upsertAsync(), or removeAsync() is called
  inside a Meteor method invocation. This allows client (the method caller) to
  be aware of mutation results and have Minimongo automatically updated without
  having to rely on traditional pub/sub.
*/

import { Mongo } from 'meteor/mongo';
import { DDP } from 'meteor/ddp-client';
import { includesOnly, createProjection } from './utils-server';

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

let publishHandlers = [];
Meteor.startup(() => {
  publishHandlers = Object.keys(Meteor.server.publish_handlers);
});

const shouldSendMutationUpdates = collectionName => {
  return (
    Meteor.settings.public.packages?.['jam:pub-sub']?.pubs.some(s => s.includes(collectionName))
    || !publishHandlers.some(s => s.includes(collectionName))
  )
}

Mongo.Collection.prototype.insertAsync = async function (doc) {
  const session = getClientSession();

  if (!session || !shouldSendMutationUpdates(this._name)) {
    return originalInsert.call(this, doc);
  }

  const _id = await originalInsert.call(this, doc);
  session.send({ msg: 'added', collection: this._name, id: _id, fields: doc });

  return _id;
};

Mongo.Collection.prototype.removeAsync = async function (selector) {
  const session = getClientSession();

  if (!session || !shouldSendMutationUpdates(this._name)) {
    return originalRemove.call(this, selector);
  }

  const resolvedSelector = Mongo.Collection._rewriteSelector(selector);
  const docIdsToBeRemoved = await this.find(resolvedSelector, { fields: { _id: 1 }}).mapAsync(doc => doc._id);
  const numRemoved = await originalRemove.call(this, selector);

  if (docIdsToBeRemoved.length === numRemoved) {
    docIdsToBeRemoved.forEach(id => {
      session.send({ msg: 'removed', id, collection: this._name })
    });
  } else if (numRemoved > 0) {
    // if some of the documents failed to remove, then only send 'removed' for the ones that were successfully removed
    const docIdsRemaining = await this.find(resolvedSelector, { fields: { _id: 1 }}).mapAsync(doc => doc._id);
    docIdsToBeRemoved.filter(id => !docIdsRemaining.includes(id)).forEach(id => {
      session.send({ msg: 'removed', id, collection: this._name })
    });
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
  const hasId = selector._id;
  let docIds;

  if (!hasId && isUpsertOrMulti) {
    docIds = options.upsert ? await rawCollection.find(selector, {projection: {_id: 1}, sort: {$natural: 1}}).map(d => d._id).toArray() : await rawCollection.distinct('_id', selector); // look up the documents before so that we can use their _ids below. we treat upsert differently because we need to predict which document will be updated using sort $natural.
  }

  const modifierKeys = Object.keys(modifier);
  const isReplace = !isUpsertOrMulti && modifierKeys.every(k => !k.includes('$'));
  const result = isUpsertOrMulti ? await originalUpdate.call(this, selector, modifier, options) : isReplace ? await rawCollection.findOneAndReplace(selector, modifier, {...options, returnDocument: 'after'}) : await rawCollection.findOneAndUpdate(selector, modifier, {...options, returnDocument: 'after'});

  const { insertedId, numberAffected, value } = result;
  if (result === 0 || value === null) {
    return 0;
  }

  if (insertedId && includesOnly(modifierKeys, ['$set', '$setOnInsert'])) { // it's an upsert and we have the data we need. if it's not a $set or $setOnInsert, then we look up the final result using the below else block
    const fields = isReplace ? modifier : { ...modifier.$set, ...modifier.$setOnInsert };
    session.send({ msg: 'added', id: insertedId, fields, collection: this._name });
  } else if (!isUpsertOrMulti) {
    const { _id, ...fields } = value;
    session.send({ msg: 'changed', id: _id, fields, collection: this._name });
  } else {
    const updateSelector = hasId ? selector : insertedId ? { _id: insertedId } : docIds ? {_id: numberAffected === 1 ? docIds[0] : {$in: docIds }} : undefined;
    const projection = createProjection(modifier);
    const items = updateSelector ? await rawCollection.find(updateSelector, projection).toArray() : [];

    if (items.length) {
      items.forEach(item => {
        const { _id, ...fields} = item;
        session.send({ msg: insertedId ? 'added' : 'changed', id: _id, fields, collection: this._name });
      })
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
