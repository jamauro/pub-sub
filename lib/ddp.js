import { Meteor } from 'meteor/meteor';
import { MongoID } from 'meteor/mongo-id';
import { subsCache } from './subs-cache';
import { seen } from './subscribe';

let hasPubs = false;
Meteor.startup(() => {
  hasPubs = Meteor.settings.public.packages?.['jam:pub-sub']?.pubs.length > 0; // these are publications created with .once
});

// Prevent potential conflicts caused by manual DDP messages from the server-side.
// These conflicts might be caused because we no longer track client's data on the
// server-side with SessionCollectionViews. Such conflicts are harmless in the context
// of the package, so we want to automatically resolve them rather than letting errors be thrown.
const _processOneDataMessageOriginal = Meteor.connection._processOneDataMessage;
Meteor.connection._processOneDataMessage = function (msg, updates) {
  const { msg: messageType, collection: collectionName, id } = msg;

  const bypass = !hasPubs
    || ['users', 'meteor_accounts_loginServiceConfiguration', 'meteor_autoupdate_clientVersions', 'tinytest_results_collection'].includes(collectionName)
    || !['added', 'changed', 'removed'].includes(messageType)
    || (collectionName === 'users' && id?.charAt(0) === '-');

  if (bypass) {
    const docs = messageType === 'updated' ? msg.methods.flatMap(methodId => this._documentsWrittenByStub[methodId] || []) : []; // this is used along with Promise.resolve below to prevent ui flicker for a .stream
    return docs.length ? Promise.resolve().then(() => _processOneDataMessageOriginal.call(this, msg, updates)) : _processOneDataMessageOriginal.call(this, msg, updates);
  }

  const parsedId = id && MongoID.idParse(id);
  const existingDoc = parsedId && Meteor.connection._mongo_livedata_collections[collectionName]?._docs?.get(parsedId);
  const serverDoc = Meteor.connection._getServerDoc(collectionName, id);
  const hasActiveRegSub = Object.values(Meteor.connection._subscriptions).some(s => s.name.toLowerCase().includes(collectionName));
  const activeSub = Object.values(subsCache).find(s => s.active && s.handle._collectionNames?.includes(collectionName)) || Object.values(seen).find(s => s.handle._collectionNames?.includes(collectionName));

  // keep track of added ids when using publish.once so that we can clean them up with removeFromMiniMongo
  if (messageType === 'added') {
    if (!hasActiveRegSub && activeSub) {
      msg.fields.__sub = activeSub.handle.subscriptionId
      this._pushUpdate(updates, msg.collection, msg); // _pushUpdate is internal to _processOneDataMessageOriginal but it wasn't being executed by the logic in there so we had to add it here. I think it would probably be preferable to return early here as an optimization but leaving as is for now.
    }
  }

  const ignore = (messageType === 'added' && serverDoc?.document?._id)
    || (messageType === 'removed' && existingDoc && activeSub && existingDoc.__sub === activeSub.handle.subscriptionId)
    || (!existingDoc && (messageType === 'changed' || messageType === 'removed' && !serverDoc?.document));

  if (hasActiveRegSub) { // sub may have been added if you have a regular publication and a .once publication on the same collection and you're navigating between them. if that's the case, we want to remove the sub when the subscription from regular publication becomes the active one.
    delete existingDoc?.__sub
  }

  if (ignore) {
    return;
  }

  return _processOneDataMessageOriginal.call(this, msg, updates);
};
