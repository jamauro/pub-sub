import { Tinytest } from 'meteor/tinytest';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { extractSubscribeArguments } from './lib/utils/client';
import { convertFilter, removeValue } from './lib/utils/server';
import { subsCache } from './lib/subs-cache';
import { PubSub } from 'meteor/jam:pub-sub';
const _isEqual = require('lodash/isEqual');

PubSub.configure({
  cache: true
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const Things = new Mongo.Collection('things');
const Notes = new Mongo.Collection('notes');
const Items = new Mongo.Collection('items');
const Books = new Mongo.Collection('books');
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
  await Markers.insertAsync({ text: 'hi' });
  await Markers.insertAsync({ text: 'bye' });
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

const insertBook = async ({ title }) => {
  return Books.insertAsync({ title });
}

const insertMarker = async ({ text }) => {
  return Markers.insertAsync({ text });
}

if (Meteor.isServer) {
  Meteor.startup(async () => {
    await reset();
    await resetNotes();
    await resetItems();
    await resetBooks();
    await resetMarkers();
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

  Meteor.methods({ reset, resetNotes, resetItems, resetBooks, resetMarkers, updateThing, updateThings, updateThingUpsert, updateThingUpsertMulti, upsertThing, replaceThing, removeThing, fetchThings })
}

// isomorphic methods
Meteor.methods({ insertThing, insertItem, insertBook, insertMarker });

if (Meteor.isClient) {
  Tinytest.addAsync('subscribe - regular publication - standard succesful', async (test) => {
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
    console.log('STANDARD notes', notes)
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

  Tinytest.addAsync('subscribe - regular pubsub - successful with Mongo.ObjectID insert', async (test) => {
    let sub;
    Tracker.autorun(() => {
      sub = Meteor.subscribe('markers.all', {cacheDuration: 0.1});
    })

    let markers;
    const computation = Tracker.autorun(() => {
      if (sub.ready()) {
        markers = Markers.find().fetch();
        sub.stop();
      }
    });

    await wait(100);
    test.isTrue(markers.length, 2)

    await Meteor.callAsync('insertMarker', {text: 'sup'});
    await wait(100);

    test.equal(markers.length, 3);
    test.isTrue(typeof markers[0]._id._str === 'string');
    computation.stop();
    await Meteor.callAsync('resetMarkers');
  });

  Tinytest.addAsync('subscribe - .stream - successful with Mongo.ObjectID insert', async (test) => {
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

    await wait(100);
    test.isTrue(markers.length, 2)

    await Meteor.callAsync('insertMarker', {text: 'sup'});
    await wait(100);
    test.equal(markers.length, 3);
    test.isTrue(typeof markers[0]._id._str === 'string');
    computation.stop();
    await Meteor.callAsync('resetMarkers');
  });

  Tinytest.addAsync('cache - regular pubsub -  succesful', async (test) => {
    let sub;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.all', {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
      }
    });

    await wait(50);
    sub.stop();

    const notes = Notes.find().fetch();
    test.equal(notes.length, 2);

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
    Meteor.call('resetNotes');
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
    Meteor.call('resetNotes');
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

    Meteor.call('resetItems');
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
    Meteor.call('resetItems');
  });

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
      Meteor.call('updateThings', {text: 'hi'}, (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result, 2);
      });

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
      Meteor.call('updateThingUpsertMulti', {text: 'hi'}, (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result, 2);
      });
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
      Meteor.call('removeThing', thing._id, (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result, 1);
      });

      Meteor.call('fetchThings', (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result.length, 1)
      });

    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - _id', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const thing = Things.findOne();
      Meteor.call('removeThing', {_id: thing._id}, (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result, 1);
      });

      Meteor.call('fetchThings', (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result.length, 1)
      });

    } catch(error) {
      test.isTrue(error = undefined);
    }
  });

  Tinytest.addAsync('remove - $eq', async (test) => {
    await Meteor.callAsync('reset');

    try {
      const thing = Things.findOne();
      Meteor.call('removeThing', {_id: {$eq: thing._id}}, (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result, 1);
      });

      Meteor.call('fetchThings', (error, result) => { // TODO: Meteor.callAsync seemed buggy here
        test.equal(result.length, 1)
      });

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
      "$or": [
        {
          "fullDocument.isPrivate": {
            "$ne": true
          }
        },
        {
          "fullDocument.owner": "123"
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({ "name": "Alice" }), { "fullDocument.name": "Alice" }));
    test.isTrue(_isEqual(convertFilter({ "address.city": "New York" }), { "fullDocument.address.city": "New York" }));

    test.isTrue(_isEqual(convertFilter({ "$or": [ { "age": { "$lt": 25 } }, { "age": { "$gt": 50 } } ] }), {
      "$or": [
        {
          "fullDocument.age": {
            "$lt": 25
          }
        },
        {
          "fullDocument.age": {
            "$gt": 50
          }
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({ "$and": [ { "status": "active" }, { "score": { "$gte": 80 } } ] }), {
      "$and": [
        {
          "fullDocument.status": "active"
        },
        {
          "fullDocument.score": {
            "$gte": 80
          }
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({ "$nor": [ { "age": { "$lt": 20 } }, { "status": "inactive" } ] }), {
      "$nor": [
        {
          "fullDocument.age": {
            "$lt": 20
          }
        },
        {
          "fullDocument.status": "inactive"
        }
      ]
    }));

    test.isTrue(_isEqual(convertFilter({
      "$or": [
        { "name": "Bob" },
        {
          "$and": [
            { "age": { "$gte": 30 } },
            { "city": "San Francisco" }
          ]
        }
      ],
      "status": "active"
    }), {
      "$or": [
        {
          "fullDocument.name": "Bob"
        },
        {
          "$and": [
            {
              "fullDocument.age": {
                "$gte": 30
              }
            },
            {
              "fullDocument.city": "San Francisco"
            }
          ]
        }
      ],
      "fullDocument.status": "active"
    }));

    test.isTrue(_isEqual(convertFilter({ "tags": { "$in": ["mongodb", "database"] } }), {
      "fullDocument.tags": {
        "$in": [
          "mongodb",
          "database"
        ]
      }
    }));

    test.isTrue(_isEqual(convertFilter({ "price": { "$gt": 100, "$lt": 500 } }), {
      "fullDocument.price": {
        "$gt": 100,
        "$lt": 500
      }
    }));

    test.isTrue(_isEqual(convertFilter({ "results": { $elemMatch: { product: { $ne: "xyz" } } } }), {
      "fullDocument.results": {
        "$elemMatch": {
          "product": {
            "$ne": "xyz"
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
}
