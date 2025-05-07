/*
  Prevent potential conflicts caused by DDP messages from the server-side.
  These conflicts might be caused because we no longer track client's data on the
  server-side with SessionCollectionViews when using .once publications
  or when reducing the amount of state kept on the server with serverState config.
  These conflicts are harmless in the context of the package, so we want to
  automatically resolve them rather than letting errors be thrown.
*/

import { Meteor } from 'meteor/meteor';
import { MongoID } from 'meteor/mongo-id';
import { subsCache } from './subs-cache';
import { subs, wait } from './utils/client';

let noSub = false;
let hasPubs = false;

Meteor.startup(() => {
  hasPubs = !!Meteor.settings.public.packages?.['jam:pub-sub']?.pubs; // these are publications created with .once or .stream
});

const bypass = (id, collection) => !hasPubs
  || ['meteor_accounts_loginServiceConfiguration', 'meteor_autoupdate_clientVersions', 'tinytest_results_collection'].includes(collection)
  || (collection === 'users' && id?.charAt(0) === '-');

const getDocs = (id, collection) => {
  const parsedId = id && MongoID.idParse(id);
  const existingDoc = parsedId && Meteor.connection._mongo_livedata_collections[collection]?._docs?.get(parsedId);
  const serverDoc = parsedId && Meteor.connection._getServerDoc(collection, parsedId);

  return { parsedId, existingDoc, serverDoc };
};

const getSub = (collection) => {
  const activeSub = Object.values(subsCache).reverse().find(s => s.active && s.handle._collectionNames?.includes(collection)); // reversing to grab the most recently active sub
  const activeRegSub = Object.values(Meteor.connection._subscriptions).reverse().find(s => !s.inactive && s.name.toLowerCase().includes(collection.toLowerCase()));
  const sub = activeRegSub?.id || activeSub?.handle.subscriptionId;

  return sub;
};

const setSub = async (collection, id, sub) => {
  await wait(10); // after a doc is added from a realtime subscription, it seems to take a few milliseconds before its available in the underlying _docs._map, so we pause here to make sure we can retrieve it. trying to do this immediately after invoking _processOneDataMessageOriginal or _process_* didn't work
  const doc = Meteor.connection._mongo_livedata_collections[collection]?._docs?.get(id);
  if (doc) (doc[subs] ||= new Set()).add(sub);

  return;
};

const _originalProcessAdded = Meteor.connection._process_added;
const _originalProcessChanged = Meteor.connection._process_changed;
const _originalProcessRemoved = Meteor.connection._process_removed;
const _livedata_nosubOriginal = Meteor.connection._livedata_nosub;

Meteor.connection._process_added = function(msg, updates) {
  const { id, collection } = msg;

  if (bypass(id, collection)) {
    return _originalProcessAdded.call(this, msg, updates);
  }

  const { parsedId, existingDoc, serverDoc } = getDocs(id, collection);
  const sub = getSub(collection);

  // track which subs added a doc so that we can clean up those docs later as appropriate with removeFromMiniMongo or when we receive a removed DDP message
  if (sub) {
    if (existingDoc) {
      (existingDoc[subs] ||= new Set()).add(sub);
    } else {
      setSub(collection, parsedId, sub)
    }
  }

  const ignore = serverDoc?.document?._id;

  if (ignore) {
    return;
  }

  return _originalProcessAdded.call(this, msg, updates);
}

Meteor.connection._process_changed = function (msg, updates) {
  const { id, collection } = msg;

  if (bypass(id, collection)) {
    return _originalProcessChanged.call(this, msg, updates);
  }

  const { existingDoc, serverDoc } = getDocs(id, collection);

  if (!existingDoc) {
    return _originalProcessAdded.call(this, msg, updates)
  }

  const ignore = !existingDoc && !serverDoc?.document;

  if (ignore) {
    return;
  }

  return _originalProcessChanged.call(this, msg, updates);
}

Meteor.connection._process_removed = function(msg, updates) {
  const { id, collection } = msg;

  if (bypass(id, collection)) {
    return _originalProcessRemoved.call(this, msg, updates);
  }

  if (noSub) {
    const sub = getSub(collection);

    if (sub) {
      const ids = existingDoc?.[subs];
      if (ids?.has(sub)) {
        for (const i of ids) {
          if (i === sub) continue;
          ids.delete(i);
        }

        if (ids.size) { // if the doc still belongs to an active sub, then we don't want to remove it, so we return early
          return;
        }
      }
    }
  }

  const { existingDoc, serverDoc } = getDocs(id, collection);
  const ignore = !existingDoc && !serverDoc?.document;

  if (ignore) {
    return;
  }

  return _originalProcessRemoved.call(this, msg, updates);
}

Meteor.connection._livedata_nosub = function (msg) {
  try {
    noSub = true;
    return _livedata_nosubOriginal.call(this, msg);
  } finally {
    Promise.resolve().then(() => noSub = false);
  }
}
