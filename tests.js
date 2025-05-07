import { Tinytest } from 'meteor/tinytest';
import { Meteor } from 'meteor/meteor';
import { Mongo, MongoInternals } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { DDP } from 'meteor/ddp-client';
import { Tracker } from 'meteor/tracker';
import { extractSubscribeArguments } from './lib/utils/client';
import { convertFilter, removeValue, trim, matchesFilter, convertObjectId } from './lib/utils/server';
import { createKey } from './lib/utils/shared';
import { subsCache } from './lib/subs-cache';
import { PubSub } from 'meteor/jam:pub-sub';

const { ObjectId } = MongoInternals?.NpmModules.mongodb.module || {};

const Cache = Meteor.isServer && require('./lib/cache').Cache || {}

const _isEqual = require('lodash/isEqual');

PubSub.configure({
  cache: true
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const Things = new Mongo.Collection('things');
const Notes = new Mongo.Collection('notes');
const Items = new Mongo.Collection('items');
const Books = new Mongo.Collection('books');
const Dogs = new Mongo.Collection('dogs');
const Markers = new Mongo.Collection('markers', {
  idGeneration: 'MONGO' // Mongo.ObjectID
});

const reset = async () => {
  await Things.removeAsync({});
  await Things.insertAsync({ text: 'hi', num: 1});
  await Things.insertAsync({ text: 'sup', num: 2});

  return;
}

const resetNotes = async () => {
  await Notes.removeAsync({});
  await Notes.insertAsync({ title: 'todos', createdAt: new Date()});
  await Notes.insertAsync({ title: 'stuff', createdAt: new Date()});
  return;
}

const resetItems = async () => {
  await Items.removeAsync({});
  await Items.insertAsync({ amount: 4 });
  await Items.insertAsync({ amount: 10 });
  return;
}

const resetBooks = async () => {
  await Books.removeAsync({});
  await Books.insertAsync({ title: 'a book' });
  await Books.insertAsync({ title: 'nice' });
  return;
}

const resetMarkers = async () => {
  await Markers.removeAsync({});
  await Markers.insertAsync({ text: 'hi', something: new Mongo.ObjectID() });
  await Markers.insertAsync({ text: 'bye', something: new Mongo.ObjectID() });
  return;
}

const resetDogs = async () => {
  await Dogs.removeAsync({});
  return;
}

const insertThing = async ({ text, num }) => {
  return Things.insertAsync({ text, num });
}
const updateThing = async (selector) => {
  return Things.updateAsync(selector, {$set: {text: 'hello'}});
}

const updateThings = async ({ text }) => {
  return Things.updateAsync({ text }, {$set: {text: 'hello'}}, {multi: true});
}

const updateThingUpsert = async ({ text }) => {
  return Things.updateAsync({ text }, {$set: {num: 5}}, {upsert: true});
}

const updateThingUpsertMulti = async ({ text }) => {
  return Things.updateAsync({ text }, {$set: {num: 8}}, {upsert: true, multi: true});
}

const upsertThing = async ({ text }) => {
  return Things.updateAsync({ text }, {$set: {num: 20}}, {upsert: true});
}

const replaceThing = async (_id) => {
  return Things.updateAsync({ _id }, {text: 's', num: 2});
}

const removeThing = async (selector) => {
  return Things.removeAsync(selector);
}

const fetchThings = async () => {
  return Things.find().fetchAsync()
}

const insertItem = async ({ amount }) => {
  return Items.insertAsync({ amount });
}

const updateItem = async ({ _id, amount }) => {
  return Items.updateAsync({ _id }, { $set: { amount }});
}

const fetchItems = async () => {
  return Items.find().fetchAsync()
}

const insertBook = async ({ title }) => {
  return Books.insertAsync({ title });
}

const insertMarker = async ({ text }) => {
  return Markers.insertAsync({ text });
}

const updateMarker = async ({ _id, text }) => {
  return Markers.updateAsync({ _id }, {$set: { text }});
}

const updateMarkers = async ({ text }) => {
  return Markers.updateAsync({ text }, {$set: {text: 'hello'}}, {multi: true});
}

const insertDog = async ({ text }) => {
  return Dogs.insertAsync({ text, ...(Meteor.isServer && { something: 1 }) });
}

const updateDog = async ({ _id, text }) => {
  return Dogs.updateAsync({ _id }, { $set: { text, ...(Meteor.isServer && { something: 2 }) }});
}

const replaceDog = async ({ _id, text }) => {
  return Dogs.updateAsync({ _id }, { text, ...(Meteor.isServer && { something: 3 }) });
}

const removeDog = async (selector) => {
  return Dogs.removeAsync(selector);
}

if (Meteor.isServer) {
  Meteor.startup(async () => {
    await reset();
    await resetNotes();
    await resetItems();
    await resetBooks();
    await resetMarkers();
    await resetDogs();
  })

  Meteor.publish('notes.all', function() {
    return Notes.find();
  });

  Meteor.publish('notes.filter', function(filter) {
    return Notes.find(filter);
  });

  Meteor.publish.once('things.all', function() {
    return Things.find();
  });

  Meteor.publish.once('items.all', function() {
    return Items.find();
  });

  Meteor.publish.once('items.single', function(_id) {
    return Items.find({_id})
  });

  Meteor.publish.once('notes.items.all', function() {
    return [Notes.find(), Items.find()];
  });

  Meteor.publish.stream('books.all', function() {
    return Books.find();
  });

  Meteor.publish('markers.all', function() {
    return Markers.find();
  });

  Meteor.publish.stream('markers.stream', function() {
    return Markers.find();
  });

  Meteor.publish.once('markers.once', function() {
    return Markers.find();
  });

  Meteor.publish.once('users.all', function() {
    return Meteor.users.find();
  });

  Meteor.publish.stream('dogs.all', function() {
    return Dogs.find({}, { fields: { text: 1 }});
  });

  Meteor.methods({ reset, resetNotes, resetItems, resetBooks, resetMarkers, resetDogs, updateThing, updateThings, updateThingUpsert, updateThingUpsertMulti, upsertThing, replaceThing, removeThing, fetchThings, updateItem, fetchItems })
}

// isomorphic methods
Meteor.methods({ insertThing, insertItem, insertBook, insertMarker, updateMarker, updateMarkers, insertDog, updateDog, replaceDog, removeDog });


function createConnection() {
  return DDP.connect(Meteor.connection._stream.rawUrl, Meteor.connection.options);
}

function callWithConnectionPromise(connection, methodName, ...args) {
  return connection.callAsync(methodName, ...args);
}

Tinytest.addAsync('cache - .once - merge when doc exists', async (test) => {
  let conn2;

  if (Meteor.isServer) {
    await resetItems();
  }

  if (Meteor.isClient) { // user A starts a session
    conn2 = createConnection(); // user B connects

    let comp;
    let sub;

    comp = Tracker.autorun(() => {
      sub = Meteor.subscribe('items.all', {cache: false});
    });

    await wait(100);
    const items = Items.find().fetch();

    test.equal(items.length, 2);
    test.isTrue(items.some(i => i.amount !== 100))

    Meteor.disconnect();
    sub.stop();
    comp.stop();

    await wait(10);
    await callWithConnectionPromise(conn2, 'updateItem', { _id: items[0]._id, amount: 100 }); // user B updates the items
  }

  if (Meteor.isClient) { // user A comes back
    await wait(100);
    Meteor.reconnect();

    const sub = Meteor.subscribe('items.all', { cacheDuration: 1 });

    const result = await Meteor.callAsync('fetchItems');
    test.equal(result.length, 2);
    test.isTrue(result.some(i => i.amount === 100))

    const items = Items.find().fetch();
    test.equal(items.length, 2);
    test.isTrue(items.some(i => i.amount === 100))

    sub.stop();
    conn2.close();
  }
});

if (Meteor.isClient) {
  Tinytest.addAsync('insert - simple', async (test) => {
    await wait(101);
    await Meteor.callAsync('reset');

    try {
      const result = await Meteor.applyAsync('insertThing', [{text: 'yo', num: 3 }]);
      const things = await Things.find().fetchAsync();
      test.isTrue(things.length, 3)
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('update - simple', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const _id = await Meteor.applyAsync('insertThing', [{ text: 'yo', num: 10 }], { returnStubValue: true })
      await Meteor.callAsync('updateThing', { _id });
      await wait(250)
      const thing = Things.findOne({_id});
      test.equal(thing.text, 'hello')
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('update - null result', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const _id = await Meteor.applyAsync('insertThing', [{ text: 'yo', num: 10 }], { returnStubValue: true })
      await Meteor.callAsync('updateThing', { _id: 'not found' });
      await wait(250)
      const thing = Things.findOne({_id});
      test.equal(thing.text, 'yo')
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('update - shorthand _id', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const _id = await Meteor.applyAsync('insertThing', [{ text: 'yo', num: 10 }], { returnStubValue: true })
      await Meteor.callAsync('updateThing', _id);
      await wait(250)
      const thing = Things.findOne({_id});
      test.equal(thing.text, 'hello')
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('update - replace', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const _id = await Meteor.applyAsync('insertThing', [{ text: 't', num: 1 }], { returnStubValue: true })
      const result = await Meteor.callAsync('replaceThing', _id)
      test.equal(result, 1);
      const thing = Things.findOne(_id);
      await wait(200);
      test.equal(thing.num, 2)
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('update - multi', async (test) => {
    await Meteor.callAsync('reset');

    try {
      await Meteor.applyAsync('insertThing', [{ text: 'hi', num: 10 }])
      const result = await Meteor.callAsync('updateThings', {text: 'hi'});

      test.equal(result, 2);

    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('update - upsert', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const initialThings = Things.find().fetch();
      const result = await Meteor.callAsync('updateThingUpsert', {text: 'hello there'});
      test.equal(result, 1);
      const things = Things.find().fetch();
      test.equal(things.length, initialThings.length + 1)
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('update - upsert multi', async (test) => {
    await Meteor.callAsync('reset');

    try {
      await Meteor.applyAsync('insertThing', [{ text: 'hi', num: 10 }])
      const result = await Meteor.callAsync('updateThingUpsertMulti', {text: 'hi'});

      test.equal(result, 2);
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('upsert - simple', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const initialThings = Things.find().fetch();
      const result = await Meteor.callAsync('upsertThing', {text: 'howdy'});
      test.equal(result, 1);
      const things = Things.find().fetch();
      test.equal(things.length, initialThings.length + 1)
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - simple', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const result = await Meteor.callAsync('removeThing', {text: 'hi'});
      test.equal(result, 1);
      const things = await Meteor.callAsync('fetchThings');

      test.equal(things.length, 1)
      test.equal(things[0].text, 'sup')
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - shorthand _id', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const thing = Things.findOne();
      const result = await Meteor.callAsync('removeThing', thing._id);

      test.equal(result, 1);

      const value = await Meteor.callAsync('fetchThings');

      test.equal(value.length, 1)

    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - _id', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const thing = Things.findOne();
      const result = await Meteor.callAsync('removeThing', {_id: thing._id});

      test.equal(result, 1);

      const value = await Meteor.callAsync('fetchThings');

      test.equal(value.length, 1)

    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - $eq', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const thing = Things.findOne();
      const result = await Meteor.callAsync('removeThing', {_id: {$eq: thing._id}});

      test.equal(result, 1);

      const value = await Meteor.callAsync('fetchThings');

      test.equal(value.length, 1)
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - $in', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const currentThings = Things.find().fetch();
      const result = await Meteor.callAsync('removeThing', {_id: {$in: currentThings.map(t => t._id)}});
      test.equal(result, 2);
      const things = await Meteor.callAsync('fetchThings');

      test.equal(things.length, 0)
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - $nin', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const currentThings = Things.find().fetch();
      const result = await Meteor.callAsync('removeThing', {_id: {$nin: currentThings.map(t => t._id)}});
      test.equal(result, 0);
      const things = await Meteor.callAsync('fetchThings');

      test.equal(things.length, 2)
    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('cache - .once - set to false', async (test) => {
    await wait(100);
    await Meteor.callAsync('resetNotes');

    let notes;
    Tracker.autorun(computation => {
      const sub = Meteor.subscribe('notes.all', {cache: false});
      if (sub.ready()) {
        notes = Notes.find().fetch();
        computation.stop();
        sub.stop();
      }
    });

    await wait(50);
    test.equal(notes.length, 2)

    await wait(250);
    const notesStop = Notes.find().fetch();

    test.equal(notesStop.length, 0)
  });

  Tinytest.addAsync('subscribe - regular publication - standard succesful', async (test) => {
    await Meteor.callAsync('resetNotes');

    PubSub.configure({
      cache: false
    });

    let sub;
    let notes;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.all');
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
        sub.stop();
      }
    });

    await wait(200)
    test.isTrue(notes.length, 2)

    PubSub.configure({
      cache: true
    });
  });

  Tinytest.addAsync('subscribe - regular publication - onReady', async (test) => {
    PubSub.configure({
      cache: false
    });

    let sub;
    let notes;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.all', {onReady: () => {}});
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
        sub.stop();
      }
    });

    await wait(200)
    test.isTrue(notes.length, 2)

    PubSub.configure({
      cache: true
    });
  });

  Tinytest.addAsync('subscribe - regular publication - cacheDuration', async (test) => {
    let sub;
    let notes;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.all', {cacheDuration: 0.1});
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
      }
    });

    await wait(200)
    sub.stop();
    test.isTrue(notes.length, 2)
  });

  Tinytest.addAsync('subscribe - .once - successful', async (test) => {
    await Meteor.callAsync('reset')

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('things.all', {cacheDuration: 0.1});
    })

    let things;
    Tracker.autorun(() => {
      if (sub.ready()) {
        things = Things.find().fetch();
      }
    });

    await wait(100);
    test.isTrue(things.length, 2)
  });

  Tinytest.addAsync('subscribe - .once - multiple collections successful', async (test) => {
    await Meteor.callAsync('resetNotes');
    await Meteor.callAsync('resetItems');

    let sub;
    let notes;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.items.all', {cacheDuration: 0.1});
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
        items = Items.find().fetch();
        sub.stop();
      }
    });

    await wait(200);
    test.isTrue(notes.length, 2);
    test.isTrue(items.length, 2);
  });

  Tinytest.addAsync('subscribe - .stream - successful', async (test) => {
    await Meteor.callAsync('resetBooks');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('books.all', {cacheDuration: 0.1});
    })

    let books;
    Tracker.autorun(computation => {
      if (sub.ready()) {
        computation.stop();
        books = Books.find().fetch();
        sub.stop();
      }
    });

    await wait(100);
    test.isTrue(books.length, 2)
  });

  Tinytest.addAsync('subscribe - .stream - successful with insert', async (test) => {
    await Meteor.callAsync('resetBooks');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('books.all', {cacheDuration: 0.1});
    })

    let books;
    Tracker.autorun(computation => {
      if (sub.ready()) {
        computation.stop();
        books = Books.find().fetch();
        sub.stop();
      }
    });

    await wait(100);
    test.isTrue(books.length, 2)

    await Meteor.callAsync('insertBook', {title: 'sup'});
    await wait(100);
    test.isTrue(books.length, 3)
    await Meteor.callAsync('resetBooks');
  });

  Tinytest.addAsync('subscribe - .stream - multiple collections successful', async (test) => {
    let sub;
    let notes;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.items.all', {cacheDuration: 0.1});
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
        items = Items.find().fetch();
        sub.stop();
      }
    });

    await wait(200);
    test.isTrue(notes.length, 2);
    test.isTrue(items.length, 2);
  });

  Tinytest.addAsync('subscribe - .stream - successful with projection', async (test) => {
    await Meteor.callAsync('resetDogs');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('dogs.all', { cacheDuration: 2 });
    })

    let dogs;
    const computation = Tracker.autorun(() => {
      if (sub.ready()) {
        dogs = Dogs.find().fetch();
      }
    });

    await wait(101);

    test.equal(dogs.length, 0)

    const dogId = await Meteor.callAsync('insertDog', {text: 'westhighland terrier'});
    await wait(200);

    test.equal(dogs.length, 1);

    const [ dog ] = dogs;
    test.isTrue(dog.text === 'westhighland terrier');
    test.isTrue(dog.something === undefined);

    await Meteor.callAsync('updateDog', { _id: dogId, text: 'westie' })
    await wait(200);

    const [ dog2 ] = Dogs.find().fetch();
    test.isTrue(dog2.text === 'westie');
    test.isTrue(dog2.something === undefined);

    await Meteor.callAsync('replaceDog', { _id: dogId, text: 'sup' })
    await wait(200);

    const [ dog3 ] = Dogs.find().fetch();
    test.isTrue(dog3.text === 'sup');
    test.isTrue(dog3.something === undefined);

    await Meteor.callAsync('removeDog', { _id: dogId })
    await wait(200);

    const finalDogs = Dogs.find().fetch();

    test.equal(finalDogs.length, 0);

    sub.stop();
    computation.stop();
  });

  Tinytest.addAsync('subscribe - .stream - successful with Mongo.ObjectID insert', async (test) => {
    await Meteor.callAsync('resetMarkers');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('markers.stream', {cacheDuration: 0.1});
    })

    let markers;
    const computation = Tracker.autorun(() => {
      if (sub.ready()) {
        markers = Markers.find().fetch();
        sub.stop();
      }
    });

    await wait(101);
    test.equal(markers.length, 2)

    await Meteor.callAsync('insertMarker', {text: 'sup'});
    await wait(100);
    test.equal(markers.length, 3);
    test.isTrue(typeof markers[0]._id._str === 'string');
    computation.stop();
  });

  Tinytest.addAsync('subscribe - regular pubsub - successful with Mongo.ObjectID insert', async (test) => {
    await Meteor.callAsync('resetMarkers');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('markers.all', {cacheDuration: 0.1});
    })

    let markers;
    const computation = Tracker.autorun(() => {
      if (sub.ready()) {
        markers = Markers.find().fetch();
        sub.stop()
      }
    });

    await wait(100);
    test.isTrue(markers.length, 2)

    await Meteor.callAsync('insertMarker', {text: 'sup'});
    await wait(100);

    test.equal(markers.length, 3);
    test.isTrue(typeof markers[0]._id._str === 'string');
    computation.stop();
  });

  Tinytest.addAsync('subscribe - .once - successful with Mongo.ObjectID insert', async (test) => {
    await Meteor.callAsync('resetMarkers');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('markers.once', {cacheDuration: 0.1});
    })

    let markers;
    const computation = Tracker.autorun(() => {
      if (sub.ready()) {
        markers = Markers.find().fetch();
        sub.stop();
      }
    });

    await wait(101);
    test.equal(markers.length, 2)

    await Meteor.callAsync('insertMarker', {text: 'sup'});
    await wait(100);
    test.equal(markers.length, 3);
    test.isTrue(typeof markers[0]._id._str === 'string');
    computation.stop();
  });

  Tinytest.addAsync('subscribe - .once - successful with Mongo.ObjectID update', async (test) => {
    await Meteor.callAsync('resetMarkers');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('markers.once', {cacheDuration: 0.1});
    })

    let markers;
    const computation = Tracker.autorun(() => {
      if (sub.ready()) {
        markers = Markers.find().fetch();
        sub.stop();
      }
    });

    await wait(101);
    test.equal(markers.length, 2)

    const _id = markers[0]._id;

    await Meteor.callAsync('updateMarker', { _id, text: 'sup' });
    await wait(100);

    test.equal(markers.length, 2);
    const marker = Markers.findOne({ _id });

    test.equal(marker.text, 'sup')
    computation.stop();
  });

  Tinytest.addAsync('subscribe - .once - successful with Mongo.ObjectID update multi', async (test) => {
    await Meteor.callAsync('resetMarkers');

    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('markers.once', {cacheDuration: 0.1});
    })

    let markers;
    const computation = Tracker.autorun(() => {
      if (sub.ready()) {
        markers = Markers.find().fetch();
        sub.stop();
      }
    });

    await wait(101);
    test.equal(markers.length, 2)

    await Meteor.callAsync('insertMarker', { text: 'hi' });
    await Meteor.callAsync('updateMarkers', { text: 'hi' });
    await wait(100);

    markers = Markers.find().fetch();
    test.equal(markers.length, 3);

    test.equal(markers.filter(m => m.text === 'hello').length, 2)
    computation.stop();
  });


  Tinytest.addAsync('cache - regular pubsub -  successful', async (test) => {
    let sub;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.all', {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
      }
    });

    await wait(100);

    const notes = Notes.find().fetch();
    test.equal(notes.length, 2);
    sub.stop();

    await wait(550);
    const notesLater = Notes.find().fetch();
    test.equal(notesLater.length, 0);
  });

  Tinytest.addAsync('cache - regular pubsub -  with filter', async (test) => {
    let sub;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.filter', { title: 'stuff' }, {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
      }
    });

    await wait(200);
    sub.stop();

    const notes = Notes.find().fetch();
    test.equal(notes.length, 1);
    test.equal(notes[0].title, 'stuff')

    await wait(550);
    const notesLater = Notes.find().fetch();
    test.equal(notesLater.length, 0);
  });

  Tinytest.addAsync('cache - .once -  with filter', async (test) => {
    let sub;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.filter', { title: 'stuff' }, {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
      }
    });

    await wait(200);
    sub.stop();
    const notes = Notes.find().fetch();
    test.equal(notes.length, 1);
    test.equal(notes[0].title, 'stuff')

    await wait(550);
    const notesLater = Notes.find().fetch();
    test.equal(notesLater.length, 0);
  });

  Tinytest.addAsync('cache - regular pubsub -  custom cacheDuration', async (test) => {
    await wait(101);
    await Meteor.callAsync('resetNotes');

    let sub;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.all', {cacheDuration: 0.25});
      if (sub.ready()) {
        computation.stop();
      }
    });

    await wait(50);
    sub.stop();

    const notes = Notes.find().fetch();
    test.equal(notes.length, 2)

    await wait(300);
    const notesStop = Notes.find().fetch();
    test.equal(notesStop.length, 0)
  });

  Tinytest.addAsync('cache - regular pubsub -  set to false', async (test) => {
    await wait(100);
    await Meteor.callAsync('resetNotes');

    let notes;
    Tracker.autorun(computation => {
      const sub = Meteor.subscribe('notes.all', {cache: false});
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
        sub.stop();
      }
    });

    await wait(50);
    test.equal(notes.length, 2)

    await wait(250);
    const notesStop = Notes.find().fetch();
    test.equal(notesStop.length, 0)
  });

  Tinytest.addAsync('cache - regular pubsub -  hit', async (test) => {
    await Meteor.callAsync('resetNotes');
    let sub1;
    let sub2;

    Tracker.autorun(computation => {
      sub1 = Meteor.subscribe('notes.all', {cacheDuration: 0.5});
      if (sub1.ready()) {
        computation.stop();
        sub1.stop();
      }
    });

    await wait(200);

    Tracker.autorun(computation => {
      sub2 = Meteor.subscribe('notes.all', {cacheDuration: 0.5});
      if (sub2.ready()) {
        computation.stop();
        sub2.stop();
      }
    });

    await wait(50);
    test.equal(sub1.subscriptionId, sub2.subscriptionId);

    await wait(100)
    await Meteor.callAsync('resetNotes');
  });

  Tinytest.addAsync('cache - regular pubsub - miss duration 0', async (test) => {
    await Meteor.callAsync('resetNotes');
    let sub1;
    let sub2;

    Tracker.autorun(computation => {
      sub1 = Meteor.subscribe('notes.all', {cacheDuration: 0});
      if (sub1.ready()) {
        computation.stop();
        sub1.stop();
      }
    });

    Tracker.autorun(computation => {
      sub2 = Meteor.subscribe('notes.all', {cacheDuration: 0});
      if (sub2.ready()) {
        computation.stop();
        sub2.stop();
      }
    });

    await wait(50);
    test.notEqual(sub1.subscriptionId, sub2.subscriptionId);

    await wait(100)
    await Meteor.callAsync('resetNotes');
  });

  // ITEMS
  Tinytest.addAsync('cache - .once - successful', async (test) => {
    await Meteor.callAsync('resetItems');

    let sub;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('items.all', {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
        sub.stop();
      }
    });

    await wait(200);
    const items = Items.find().fetch();
    test.equal(items.length, 2);

    let called = false;
    Tracker.autorun(computation => {
      if (!called) {
        called = true;
        sub2 = Meteor.subscribe('things.all', {cacheDuration: 0.25});
        sub.stop()
        if (sub2.ready()) {
          computation.stop();
          sub2.stop()
        }
      }
    })

    await wait(500);
    const itemsLater = Items.find().fetch();
    test.equal(itemsLater.length, 0);
  });

  Tinytest.addAsync('cache - .once - custom cacheDuration', async (test) => {
    await wait(101);
    await Meteor.callAsync('resetItems');

    const _id = await Meteor.applyAsync('insertItem', [{ amount: 100 }], { returnStubValue: true })

    let sub;

    Tracker.autorun(computation => {
      sub = Meteor.subscribe('items.all', {cacheDuration: 0.25});
      if (sub.ready()) {
        computation.stop();
      }
    });

    await wait(50);
    const items = Items.find().fetch()
    test.equal(items.length, 3)

    await wait(1)

    let called = false;
    Tracker.autorun(computation => {
      if (!called) {
        called = true;
        sub2 = Meteor.subscribe('items.single', _id, {cacheDuration: 0.25});
        sub.stop()
        if (sub2.ready()) {
          computation.stop();
          sub2.stop()
        }
      }
    })

    await wait(501);
    const itemsStop = Items.find().fetch();
    test.equal(itemsStop.length, 1)
  });

  Tinytest.addAsync('cache - .once - hit', async (test) => {
    await Meteor.callAsync('resetItems');
    let sub1;
    let sub2;

    Tracker.autorun(computation => {
      sub1 = Meteor.subscribe('items.all', {cacheDuration: 0.5});
      if (sub1.ready()) {
        computation.stop();
        sub1.stop();
      }
    });

    await wait(200);

    Tracker.autorun(computation => {
      sub2 = Meteor.subscribe('items.all', {cacheDuration: 0.5});
      if (sub2.ready()) {
        computation.stop();
        sub2.stop();
      }
    });

    await wait(50);
    test.equal(sub1.subscriptionId, sub2.subscriptionId);

    await Meteor.callAsync('resetItems');
  });

  Tinytest.addAsync('cache - .once - miss duration 0', async (test) => {
    await Meteor.callAsync('resetItems');
    let sub1;
    let sub2;

    Tracker.autorun(computation => {
      sub1 = Meteor.subscribe('items.all', {cacheDuration: 0});
      if (sub1.ready()) {
        computation.stop();
        sub1.stop();
      }
    });

    Tracker.autorun(computation => {
      sub2 = Meteor.subscribe('items.all', {cacheDuration: 0});
      if (sub2.ready()) {
        computation.stop();
        sub2.stop();
      }
    });

    await wait(50);
    test.notEqual(sub1.subscriptionId, sub2.subscriptionId);

    await wait(100)
    await Meteor.callAsync('resetItems');
  });

  Tinytest.addAsync('clearCache', async (test) => {
    await Meteor.callAsync('resetNotes');
    await Meteor.callAsync('resetItems');
    PubSub.clearCache();

    let sub1;
    let sub2;

    const numSubs = Object.keys(subsCache).length;
    test.equal(numSubs, 0);

    Tracker.autorun(computation => {
      sub1 = Meteor.subscribe('notes.all');
      if (sub1.ready()) {
        computation.stop();
      }
    });

    Tracker.autorun(computation => {
      sub2 = Meteor.subscribe('items.all');
      if (sub2.ready()) {
        computation.stop();
      }
    });

    await wait(50);
    test.equal(Object.keys(subsCache).length, numSubs + 2);
    PubSub.clearCache();
    test.equal(Object.keys(subsCache).length, 0);
  });

  Tinytest.addAsync('configure', async (test) => {
    test.equal(PubSub.config.cache, true);
    test.equal(PubSub.config.cacheDuration, 60);

    PubSub.configure({
      cache: false,
      cacheDuration: 30
    });

    test.equal(PubSub.config.cache, false);
    test.equal(PubSub.config.cacheDuration, 30);

    PubSub.configure({
      cache: true,
      cacheDuration: 2 * 60
    });

    test.equal(PubSub.config.cache, true);
    test.equal(PubSub.config.cacheDuration, 120);
  });

  Tinytest.addAsync('extract args - simple', async (test) => {
    const args = [10]
    const { args: subscribeArgs, onStop, onReady, cache, cacheDuration } = extractSubscribeArguments(args);
    test.equal(subscribeArgs, [10]);
    test.equal(onStop, undefined)
    test.equal(onReady, undefined)
    test.equal(cache, undefined)
    test.equal(cacheDuration, undefined)
  });

  Tinytest.addAsync('extract args - object', async (test) => {
    const args = [{num: 10}]
    const { args: subscribeArgs, onStop, onReady, cache, cacheDuration } = extractSubscribeArguments(args);
    test.equal(subscribeArgs, args);
    test.equal(onStop, undefined)
    test.equal(onReady, undefined)
    test.equal(cache, undefined)
    test.equal(cacheDuration, undefined)
  });

  Tinytest.addAsync('extract args - cache only', async (test) => {
    const args = [{num: 10}, { cache: true }]
    const { args: subscribeArgs, onStop, onReady, cache, cacheDuration } = extractSubscribeArguments(args);
    test.equal(subscribeArgs, [{num: 10}]);
    test.equal(onStop, undefined)
    test.equal(onReady, undefined)
    test.equal(cache, true)
    test.equal(cacheDuration, undefined)
  });

  Tinytest.addAsync('extract args - cacheDuration only', async (test) => {
    const args = [{num: 10}, { cacheDuration: 3 }]
    const { args: subscribeArgs, onStop, onReady, cache, cacheDuration } = extractSubscribeArguments(args);
    test.equal(subscribeArgs, [{num: 10}]);
    test.equal(onStop, undefined)
    test.equal(onReady, undefined)
    test.equal(cache, undefined)
    test.equal(cacheDuration, 3)
  });

  Tinytest.addAsync('extract args - all the things', async (test) => {
    const args = [{num: 10}, { onStop: () => {}, onReady: () => {}, cache: true, cacheDuration: 3 }]
    const { args: subscribeArgs, onStop, onReady, cache, cacheDuration } = extractSubscribeArguments(args);
    test.equal(subscribeArgs, [{num: 10}]);
    test.equal(typeof onStop, 'function')
    test.equal(typeof onReady, 'function')
    test.equal(cache, true)
    test.equal(cacheDuration, 3)
  });

  Tinytest.addAsync('extract args - multi args', async (test) => {
    const args = [{num: 10}, {_id: 1}, { onStop: () => {}, onReady: () => {}, cache: false, cacheDuration: 5 }]
    const { args: subscribeArgs, onStop, onReady, cache, cacheDuration } = extractSubscribeArguments(args);
    test.equal(subscribeArgs, [{num: 10}, {_id: 1}]);
    test.equal(typeof onStop, 'function')
    test.equal(typeof onReady, 'function')
    test.equal(cache, false)
    test.equal(cacheDuration, 5)
  });
}

if (Meteor.isServer) {
  Tinytest.addAsync('convertFilter', async (test) => {
    test.isTrue(_isEqual(convertFilter({
      $or: [
        { isPrivate: { $ne: true } },
        { owner: '123' },
      ],
    }), {
      '$or': [
        {
          'fullDocument.isPrivate': {
            '$ne': true
          }
        },
        {
          'fullDocument.owner': '123'
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({ 'name': 'Alice' }), { 'fullDocument.name': 'Alice' }));
    test.isTrue(_isEqual(convertFilter({ 'address.city': 'New York' }), { 'fullDocument.address.city': 'New York' }));

    test.isTrue(_isEqual(convertFilter({ '$or': [ { 'age': { '$lt': 25 } }, { 'age': { '$gt': 50 } } ] }), {
      '$or': [
        {
          'fullDocument.age': {
            '$lt': 25
          }
        },
        {
          'fullDocument.age': {
            '$gt': 50
          }
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({ '$and': [ { 'status': 'active' }, { 'score': { '$gte': 80 } } ] }), {
      '$and': [
        {
          'fullDocument.status': 'active'
        },
        {
          'fullDocument.score': {
            '$gte': 80
          }
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({ '$nor': [ { 'age': { '$lt': 20 } }, { 'status': 'inactive' } ] }), {
      '$nor': [
        {
          'fullDocument.age': {
            '$lt': 20
          }
        },
        {
          'fullDocument.status': 'inactive'
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({
      '$or': [
        { 'name': 'Bob' },
        {
          '$and': [
            { 'age': { '$gte': 30 } },
            { 'city': 'San Francisco' }
          ]
        }
      ],
      'status': 'active'
    }), {
      '$or': [
        {
          'fullDocument.name': 'Bob'
        },
        {
          '$and': [
            {
              'fullDocument.age': {
                '$gte': 30
              }
            },
            {
              'fullDocument.city': 'San Francisco'
            }
          ]
        }
      ],
      'fullDocument.status': 'active'
    }));

    test.isTrue(_isEqual(convertFilter({ 'tags': { '$in': ['mongodb', 'database'] } }), {
      'fullDocument.tags': {
        '$in': [
          'mongodb',
          'database'
        ]
      }
    }));

    test.isTrue(_isEqual(convertFilter({ 'price': { '$gt': 100, '$lt': 500 } }), {
      'fullDocument.price': {
        '$gt': 100,
        '$lt': 500
      }
    }));

    test.isTrue(_isEqual(convertFilter({ 'results': { $elemMatch: { product: { $ne: 'xyz' } } } }), {
      'fullDocument.results': {
        '$elemMatch': {
          'product': {
            '$ne': 'xyz'
          }
        }
      }
    }));
  });


  Tinytest.add('removeValue - top-level fields only', function (test) {
    const obj = {
      name: 'Alice',
      age: 30,
      city: 'New York',
    };
    const result = removeValue(obj, 'New York');
    const expected = {
      name: 'Alice',
      age: 30,
    };
    test.isTrue(_isEqual(result, expected));
  });

  Tinytest.add('removeValue - nested object', function (test) {
    const obj = {
      person: {
        name: 'Alice',
        age: 30,
        address: {
          city: 'New York',
          zip: '10001',
        },
      },
    };
    const result = removeValue(obj, 'New York');
    const expected = {
      person: {
        name: 'Alice',
        age: 30,
        address: {
          zip: '10001',
        },
      },
    };
    test.isTrue(_isEqual(result, expected));
  });

  Tinytest.add('removeValue - $or condition', function (test) {
    const obj = {
      $or: [
        { city: 'New York' },
        { city: 'Los Angeles' },
        { country: 'USA' },
      ],
    };
    const result = removeValue(obj, 'New York');
    const expected = {
      $or: [
        { city: 'Los Angeles' },
        { country: 'USA' },
      ],
    };
    test.isTrue(_isEqual(result, expected));
  });

  Tinytest.add('removeValue - $and condition with single remaining', function (test) {
    const obj = {
      $and: [
        { city: 'New York' },
        { city: 'Los Angeles' },
        { country: 'USA' },
      ],
    };
    const result = removeValue(obj, 'New York');
    const expected = {
      $and: [
        { city: 'Los Angeles' },
        { country: 'USA' },
      ],
    };
    test.isTrue(_isEqual(result, expected));
  });

  Tinytest.add('removeValue - $and with one element left', function (test) {
    const obj = {
      $and: [
        { city: 'New York' },
        { city: 'New York' },
        { country: 'USA' },
      ],
    };
    const result = removeValue(obj, 'New York');
    const expected = { country: 'USA' };  // Only one condition remains, so it should not be wrapped in $and
    test.isTrue(_isEqual(result, expected));
  });

  Tinytest.add('removeValue - $nor condition', function (test) {
    const obj = {
      $nor: [
        { city: 'New York' },
        { city: 'Los Angeles' },
        { country: 'Canada' },
      ],
    };
    const result = removeValue(obj, 'Los Angeles');
    const expected = {
      $nor: [
        { city: 'New York' },
        { country: 'Canada' },
      ],
    };
    test.isTrue(_isEqual(result, expected));
  });

  Tinytest.add('removeValue - $or condition with empty array', function (test) {
    const obj = {
      $or: [
        { city: 'New York' },
        { city: 'New York' },
      ],
    };
    const result = removeValue(obj, 'New York');
    const expected = {};  // If the array becomes empty, it should return an empty object

    test.isTrue(_isEqual(result, expected));
  });

  Tinytest.add('trim - normal case', function (test) {
    test.equal(trim([1, 2, 3, 4, 5], 1, 3), [2, 3, 4]);
  });

  Tinytest.add('trim - skip is 0', function (test) {
    test.equal(trim([1, 2, 3, 4], 0, 2), [1, 2]);
  });

  Tinytest.add('trim - limit larger than array length', function (test) {
    test.equal(trim([1, 2], 0, 10), [1, 2]);
  });

  Tinytest.add('trim - skip exceeds array length', function (test) {
    test.equal(trim([1, 2, 3], 5, 2), []);
  });

  Tinytest.add('trim - limit is zero', function (test) {
    test.equal(trim([1, 2, 3], 0, 0), []);
  });

  Tinytest.add('trim - negative limit', function (test) {
    test.equal(trim([1, 2, 3], 0, -5), []);
  });

  Tinytest.add('trim - exact end of array', function (test) {
    test.equal(trim([1, 2, 3, 4], 2, 2), [3, 4]);
  });

  Tinytest.add('trim - limit trims to end of array', function (test) {
    test.equal(trim([1, 2, 3, 4], 2, 5), [3, 4]);
  });

  Tinytest.add('matchesFilter - should return true when document matches filter', function(test) {
    const doc = { _id: 1, name: 'John', age: 30 };
    const filter = { _id: 1, name: 'John' };

    test.isTrue(matchesFilter(doc, filter), 'Document matches the filter');
  });

  Tinytest.add('matchesFilter - should return false when document does not match filter', function(test) {
    const doc = { _id: 1, name: 'John', age: 30 };
    const filter = { _id: 2, name: 'John' };

    test.isFalse(matchesFilter(doc, filter), 'Document does not match the filter');
  });

  Tinytest.add('matchesFilter - should handle $in operator for _id field', function(test) {
    const doc = { _id: 1, name: 'John', age: 30 };
    const filter = { _id: { $in: [1, 2] } };

    test.isTrue(matchesFilter(doc, filter), 'Document matches the filter with $in operator');
  });

  Tinytest.add('matchesFilter - should return false for $in operator when _id is not in array', function(test) {
    const doc = { _id: 3, name: 'John', age: 30 };
    const filter = { _id: { $in: [1, 2] } };

    test.isFalse(matchesFilter(doc, filter), 'Document does not match the filter with $in operator');
  });

  Tinytest.add('matchesFilter - should handle fields other than _id', function(test) {
    const doc = { _id: 1, name: 'John', age: 30 };
    const filter = { name: 'John', age: 30 };

    test.isTrue(matchesFilter(doc, filter), 'Document matches the filter for non-_id fields');
  });

  Tinytest.add('matchesFilter - should return false if any non-_id field does not match', function(test) {
    const doc = { _id: 1, name: 'John', age: 30 };
    const filter = { name: 'John', age: 25 };

    test.isFalse(matchesFilter(doc, filter), 'Document does not match the filter for non-_id fields');
  });

  Tinytest.add('matchesFilter - should return true when filter is empty', function(test) {
    const doc = { _id: 1, name: 'John', age: 30 };
    const filter = {};

    test.isTrue(matchesFilter(doc, filter), 'Empty filter matches all documents');
  });

  Tinytest.add('convertObjectId - converts Mongo.ObjectID to ObjectId', function (test) {
    const meteorId = new MongoID.ObjectID();
    const result = convertObjectId({ _id: meteorId });
    test.instanceOf(result._id, ObjectId);
    test.equal(result._id.toHexString(), meteorId.valueOf());
  });

  Tinytest.add('convertObjectId - converts ObjectId to Mongo.ObjectID', function (test) {
    const mongoId = new ObjectId();
    const result = convertObjectId({ _id: mongoId });
    test.instanceOf(result._id, MongoID.ObjectID);
    test.equal(result._id.valueOf(), mongoId.toHexString());
  });

  Tinytest.add('convertObjectId - handles nested objects', function (test) {
    const meteorId = new MongoID.ObjectID();
    const input = {
      user: {
        _id: meteorId,
        createdAt: new Date()
      }
    };
    const result = convertObjectId(input);

    test.instanceOf(result.user._id, ObjectId);
    test.instanceOf(result.user.createdAt, Date);
    test.equal(result.user._id.toHexString(), meteorId.valueOf());
  });

  Tinytest.add('convertObjectId - handles arrays of objects', function (test) {
    const meteorId = new MongoID.ObjectID();
    const input = [
      { _id: meteorId },
      { name: 'test', value: 42 }
    ];
    const result = convertObjectId(input);
    test.instanceOf(result[0]._id, ObjectId);
    test.equal(result[0]._id.toHexString(), meteorId.valueOf());
    test.equal(result[1].name, 'test');
    test.equal(result[1].value, 42);
  });

  Tinytest.add('convertObjectId - handles primitive values', function (test) {
    test.equal(convertObjectId(null), null);
    test.equal(convertObjectId(42), 42);
    test.equal(convertObjectId('string'), 'string');
    test.equal(convertObjectId(true), true);
  });

  Tinytest.add('convertObjectId - leaves empty objects unchanged', function (test) {
    test.equal(convertObjectId({}), {});
  });

  Tinytest.add('convertObjectId - handles nested structure from Meteor to Mongo', function (test) {
    const input = {
      list: [
        { a: new MongoID.ObjectID() },
        { b: new MongoID.ObjectID() },
        { c: { d: new MongoID.ObjectID() } }
      ]
    };

    const result = convertObjectId(input);
    test.instanceOf(result.list[0].a, ObjectId);
    test.instanceOf(result.list[1].b, ObjectId);
    test.instanceOf(result.list[2].c.d, ObjectId);
  });

  Tinytest.add('convertObjectId - handles nested structure from Mongo to Meteor', function (test) {
    const input = {
      list: [
        { a: new ObjectId() },
        { b: new ObjectId() },
        { c: { d: new ObjectId() } }
      ]
    };

    const result = convertObjectId(input);

    test.instanceOf(result.list[0].a, Mongo.ObjectID);
    test.instanceOf(result.list[1].b, Mongo.ObjectID);
    test.instanceOf(result.list[2].c.d, Mongo.ObjectID);
  });

  Tinytest.add('convertObjectId - handles MongoDB special operators', function(test) {
    // $in
    const queryWithInOperator = {
      'user.address.city': { $in: [new Mongo.ObjectID(), new Mongo.ObjectID()] }
    };

    const result = convertObjectId(queryWithInOperator);

    test.equal(result['user.address.city'].$in[0] instanceof ObjectId, true, 'Should convert ObjectId inside $in array');
    test.equal(result['user.address.city'].$in[1] instanceof ObjectId, true, 'Should convert ObjectId inside $in array');

    // $nin
    const queryWithNinOperator = {
      'user.address.city': { $nin: [new Mongo.ObjectID(), new Mongo.ObjectID()] }
    };
    const resultNin = convertObjectId(queryWithNinOperator);
    test.equal(resultNin['user.address.city'].$nin[0] instanceof ObjectId, true, 'Should convert ObjectId inside $nin array');
    test.equal(resultNin['user.address.city'].$nin[1] instanceof ObjectId, true, 'Should convert ObjectId inside $nin array');

    // $set operator with nested ObjectId values
    const queryWithSetOperator = {
      $set: {
        'user.address.city': new Mongo.ObjectID(),
        'user.address.country': new Mongo.ObjectID()
      }
    };
    const resultSet = convertObjectId(queryWithSetOperator);
    test.equal(resultSet.$set['user.address.city'] instanceof ObjectId, true, 'Should convert ObjectId inside $set');
    test.equal(resultSet.$set['user.address.country'] instanceof ObjectId, true, 'Should convert ObjectId inside $set');

    // Nested object with ObjectIds, not using MongoDB operators
    const queryWithNestedObjects = {
      user: {
        address: {
          city: new Mongo.ObjectID(),
          country: new Mongo.ObjectID()
        }
      }
    };
    const resultNested = convertObjectId(queryWithNestedObjects);
    test.equal(resultNested.user.address.city instanceof ObjectId, true, 'Should convert ObjectId in nested object');
    test.equal(resultNested.user.address.country instanceof ObjectId, true, 'Should convert ObjectId in nested object');

    // Complex query with both regular fields and operators
    const complexQuery = {
      'user.address.city': { $in: [new Mongo.ObjectID(), new Mongo.ObjectID()] },
      'user.age': { $gt: 25 },
      'user.name': 'John'
    };
    const resultComplex = convertObjectId(complexQuery);
    test.equal(resultComplex['user.address.city'].$in[0] instanceof ObjectId, true, 'Should convert ObjectId inside $in array');
    test.equal(resultComplex['user.address.city'].$in[1] instanceof ObjectId, true, 'Should convert ObjectId inside $in array');
    test.equal(resultComplex['user.age'].$gt, 25, 'Should retain $gt value');
    test.equal(resultComplex['user.name'], 'John', 'Should retain regular field value');
  });
}

Tinytest.addAsync('subscribe - .once - current user is not removed', async (test) => {
  await wait(500); // run this test last so it doesn't interfere with other tests

  const userId = '1234';
  const originalMeteorUserId = Meteor.userId;
  Meteor.userId = () => userId;

  if (Meteor.isServer) {
    await Meteor.users.removeAsync({});
    await Meteor.users.insertAsync({ _id: userId, email: 'test1@example.com' });
    await Meteor.users.insertAsync({ email: 'test2@example.com' });
  }

  if (Meteor.isClient) {
    let sub;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('users.all', {cacheDuration: 0});
      if (sub.ready()) {
        computation.stop();
        sub.stop();
      }
    });

    await wait(20);
    const users = Meteor.users.find().fetch();

    test.isTrue(users.length, 1)
    test.isTrue(users[0]._id === Meteor.userId())
  }

  Meteor.userId = originalMeteorUserId;
});

//// Testing Cache /////
if (Meteor.isServer) {
  Tinytest.add('Cache - insert new document', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key' });
    const doc = { _id: 'mocked-id', name: 'Document 1' };

    Cache.get(key);
    Cache.set(key, [doc]);

    const entry = Cache.get(key);

    test.equal(entry.docs.length, 1, 'Document should be inserted into the cache');
    test.equal(entry.docs[0]._id, doc._id, 'Inserted document should have the correct _id');
  });

  Tinytest.add('Cache - replace existing document', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key' });
    const doc = { _id: 'mocked-id', name: 'Document 1' };
    Cache.set(key, [doc]);

    const updatedDoc = { _id: 'mocked-id', name: 'Updated Document' };
    Cache.set(key, [updatedDoc]);

    const entry = Cache.get(key);

    test.equal(entry.docs.length, 1, 'Document should still exist in the cache after replacement');
    test.equal(entry.docs[0].name, 'Updated Document', 'Document should be replaced correctly');
  });

  Tinytest.add('Cache - get cached documents', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key' });
    const doc = { _id: 'mocked-id', name: 'Document 1' };
    Cache.set(key, [doc]);

    const entry = Cache.get(key);

    test.equal(entry.docs.length, 1, 'Should fetch the document from the cache');
    test.equal(entry.docs[0]._id, doc._id, 'Fetched document should have the correct _id');
  });

  Tinytest.add('Cache - limit enforced', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key-limit' });
    const docs = [
      { _id: '1', name: 'Document 1' },
      { _id: '2', name: 'Document 2' },
    ];
    Cache.get(key, { limit: 1 });
    Cache.set(key, docs);

    const entry = Cache.get(key, { limit: 1 });

    test.equal(entry.docs.length, 1, 'Should fetch one document according to limit');
    test.equal(entry.docs[0]._id, '1', 'The correct document should be fetched');
  });

  Tinytest.addAsync('Cache - update document in cache', async function (test) {
    const key = createKey({ collectionName: 'things', filter: { _id: 'mocked-id' } });
    const doc = { _id: 'mocked-id', name: 'Document 1' };
    Cache.get(key);
    Cache.set(key, [doc]);

    const updatedDoc = { _id: 'mocked-id', name: 'Updated Document' };
    await Cache.update(key, updatedDoc, 'update');

    const entry = Cache.get(key);

    test.equal(entry.docs.length, 1, 'Document should still exist in the cache after update');
    test.equal(entry.docs[0].name, 'Updated Document', 'Document should be updated correctly');
  });

  Tinytest.addAsync('Cache - update document that no longer matches filter', async function (test) {
    const key = createKey({ collectionName: 'things', filter: { name: 'Document 2' } });
    const doc = { _id: 'mocked-id', name: 'Document 2' };
    Cache.get(key);
    Cache.set(key, [doc]);

    const updatedDoc = { _id: 'mocked-id', name: 'Non-matching Document' };
    await Cache.update(key, updatedDoc, 'update');

    const entry = Cache.get(key);

    test.equal(entry.docs.length, 0, 'Document should be removed if it no longer matches the filter');
  });

  Tinytest.add('Cache - delete document from cache', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key' });
    const doc = { _id: 'mocked-id', name: 'Document 1' };
    Cache.set(key, [doc]);

    Cache.delete(key, doc);

    const entry = Cache.get(key);

    test.equal(entry.docs.length, 0, 'Document should be removed from the cache');
  });

  Tinytest.add('Cache - set timestamp for document', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key', sort: { updatedAt: -1 } });
    const doc = { _id: 'mocked-id', name: 'Document 1', updatedAt: new Date() };
    Cache.get(key); // init
    Cache.set(key, [doc]);

    Cache.setTimestamp(key, 'mocked-sub-id', doc);
    const entry = Cache.get(key);

    test.isTrue(entry.timestamps.size > 0, 'Timestamps should be set correctly for the document');
  });

  Tinytest.add('Cache - clear timestamp for document', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key', sort: { updatedAt: -1 } });
    const doc = { _id: 'mocked-id', name: 'Document 1', updatedAt: new Date() };
    Cache.get(key); // init
    Cache.set(key, [doc]);

    Cache.setTimestamp(key, 'mocked-sub-id', doc);
    Cache.clearTimestamp(key, 'mocked-sub-id');

    const entry = Cache.get(key);

    test.equal(entry.timestamps.size, 0, 'Timestamps should be cleared correctly');
  });

  Tinytest.add('Cache - Clear the entire cache', function (test) {
    const key = createKey({ collectionName: 'things', filter: 'some-key' });
    const doc = { _id: 'mocked-id', name: 'Document 1' };
    Cache.set(key, [doc]);

    Cache.clear();

    test.equal(Cache.get(key).docs.length, 0, 'Cache should be cleared and contain no documents');
  });
}
////
