/*
  Prevent potential conflicts caused by DDP messages from the server-side.
  These conflicts might be caused because we no longer track client's data on the
  server-side with SessionCollectionViews when using .once publications.
  These conflicts are harmless in the context of the package, so we want to
  automatically resolve them rather than letting errors be thrown.
*/

import { Meteor } from 'meteor/meteor';
import { MongoID } from 'meteor/mongo-id';
import { subsCache } from './subs-cache';
import { seen } from './subscribe';
import { subs, wait } from './utils/client';

let hasPubs = false;
Meteor.startup(() => {
  hasPubs = !!Meteor.settings.public.packages?.['jam:pub-sub']?.pubs; // these are publications created with .once or .stream
});

const setSub = async (collectionName, id, sub) => {
  await wait(10); // after a doc is added from a realtime subscription, it seems to take a few milliseconds before its available in the underlying _docs._map, so we pause here to make sure we can retrieve it. trying to do this immediately after invoking _processOneDataMessageOriginal did *not* work
  const doc = Meteor.connection._mongo_livedata_collections[collectionName]?._docs?.get(id);
  if (doc) (doc[subs] ||= new Set()).add(sub);
  return;
};

const _processOneDataMessageOriginal = Meteor.connection._processOneDataMessage;
Meteor.connection._processOneDataMessage = function (msg, updates) {
  const { msg: messageType, collection: collectionName, id } = msg;

  const bypass = !hasPubs
    || ['users', 'meteor_accounts_loginServiceConfiguration', 'meteor_autoupdate_clientVersions', 'tinytest_results_collection'].includes(collectionName)
    || !['added', 'changed', 'removed'].includes(messageType)
    || (collectionName === 'users' && id?.charAt(0) === '-');

  if (bypass) {
    return _processOneDataMessageOriginal.call(this, msg, updates);
  }

  const parsedId = id && MongoID.idParse(id);
  const existingDoc = parsedId && Meteor.connection._mongo_livedata_collections[collectionName]?._docs?.get(parsedId);
  const serverDoc = parsedId && Meteor.connection._getServerDoc(collectionName, parsedId);
  const activeSub = Object.values(subsCache).reverse().find(s => s.active && s.handle._collectionNames?.includes(collectionName)) || Object.values(seen).reverse().find(s => s.handle._collectionNames?.includes(collectionName)); // reversing to grab the most recently active sub
  const activeRegSub = Object.values(Meteor.connection._subscriptions).reverse().find(s => s.name.toLowerCase().includes(collectionName.toLowerCase()));
  const sub = activeRegSub?.id || activeSub?.handle.subscriptionId;

  // track which subs added a doc so that we can clean up those docs later as appropriate with removeFromMiniMongo or when we receive a removed DDP message
  if (messageType === 'added' && sub) {
    if (existingDoc) {
      (existingDoc[subs] ||= new Set()).add(sub);
    } else {
      setSub(collectionName, parsedId, sub)
    }
  }

  if (messageType === 'removed' && sub) {
    const ids = existingDoc?.[subs];
    if (ids?.has(sub)) {
      for (const i of ids) {
        if (i === sub) continue;
        ids.delete(i);
      }

      if (!activeRegSub && ids.size) { // if the doc still belongs to a .once sub, then we don't want to remove it, so we return early
        return;
      }
    }
  }

  const ignore = (messageType === 'added' && serverDoc?.document?._id)
    || (!existingDoc && (messageType === 'changed' || messageType === 'removed' && !serverDoc?.document));

  if (ignore) {
    return;
  }

  return _processOneDataMessageOriginal.call(this, msg, updates);
};
