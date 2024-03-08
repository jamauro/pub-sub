import { check } from 'meteor/check';
import { overrideLowLevelPublishAPI, mergeDocIntoFetchResult } from './utils-server';

function addPublicationName(name) {
  Meteor.settings.public.packages = Meteor.settings.public.packages || {};
  Meteor.settings.public.packages['jam:pub-sub'] = Meteor.settings.public.packages['jam:pub-sub'] || {};
  return (Meteor.settings.public.packages['jam:pub-sub'].pubs ||= []).push(name);
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

  addPublicationName(name);

  Meteor.methods({
    [name]: async function(...args) {
      const customAddedDocuments = [];

      overrideLowLevelPublishAPI(this, customAddedDocuments);

      const handlerReturn = handler.apply(this, args);
      const isSingleCursor = handlerReturn && handlerReturn._publishCursor;
      const isArrayOfCursors = Array.isArray(handlerReturn) && handlerReturn.every(cursor => cursor._publishCursor);
      const fetchResult = {};

      // Validate the cursor(s)
      if (handlerReturn && !isSingleCursor && !isArrayOfCursors) {
        throw new Error(`Handler for '${name}' returns invalid cursor(s).`);
      }

      if (isArrayOfCursors) {
        const collectionNamesInCursors = handlerReturn.map(cursor => cursor._cursorDescription.collectionName);
        const hasDuplicatedCollections = new Set(collectionNamesInCursors).size !== collectionNamesInCursors.length;
        // This rule is enforced in the original publish() function
        if (hasDuplicatedCollections)
          throw new Error(`Handler for '${name}' returns an array containing cursors of the same collection.`);
      }

      // Fetch the cursor(s)
      if (isSingleCursor) {
        Object.assign(fetchResult, {
          [handlerReturn._cursorDescription.collectionName]: await handlerReturn.fetchAsync()
        });
      } else if (isArrayOfCursors) {
        const promises = handlerReturn.map(async cursor => {
          return {
            [cursor._cursorDescription.collectionName]: await cursor.fetchAsync()
          };
        });

        const results = await Promise.all(promises);
        Object.assign(fetchResult, ...results);
      } else {
        // no-op: The original publish handler didn't return any cursor. This may
        // happen when, for example, a certain authentication check fails and the
        // handler exits early with this.ready() called to signal an empty publication.
        // In this case we simply return fetchResult as an empty object.
      }

      for (const doc of customAddedDocuments) {
        mergeDocIntoFetchResult(doc, fetchResult);
      }

      return fetchResult;
    }
  });
};

Meteor.publish.once = publishOnce;
