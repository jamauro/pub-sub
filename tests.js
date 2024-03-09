import { Tinytest } from 'meteor/tinytest';
import { Mongo } from 'meteor/mongo';
import { Tracker } from 'meteor/tracker';
import { merge, extractSubscribeArguments } from './lib/utils-client';
import { subsCache } from './lib/subs-cache';
import { PubSub } from 'meteor/jam:pub-sub';
const _merge = require('lodash/merge');
const _isEqual = require('lodash/isEqual');

PubSub.configure({
  cache: true
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const Things = new Mongo.Collection('things');
const Notes = new Mongo.Collection('notes');
const Items = new Mongo.Collection('items');

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

if (Meteor.isServer) {
  Meteor.startup(async () => {
    await reset();
    await resetNotes();
    await resetItems();
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

  Meteor.methods({ updateThing, updateThings, updateThingUpsert, updateThingUpsertMulti, upsertThing, replaceThing, removeThing, fetchThings })
}

// isomorphic methods
Meteor.methods({ reset, resetNotes, resetItems, insertThing, insertItem });

if (Meteor.isClient) {
  Tinytest.addAsync('subscribe - regular publication successful', async (test) => {
    let sub;
    let notes;
    Tracker.autorun(computation => {
      sub = Meteor.subscribe('notes.all', {cacheDuration: 0.1});
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
        sub.stop();
      }
    });

    await wait(200)
    test.isTrue(notes.length, 2)
  });

  Tinytest.addAsync('subscribe - .once successful', async (test) => {
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

  Tinytest.addAsync('subscribe - .once with multiple collections successful', async (test) => {
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

  Tinytest.addAsync('cache - regular pubsub -  succesful', async (test) => {
    Tracker.autorun(computation => {
      const sub = Meteor.subscribe('notes.all', {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
        sub.stop();
      }
    });

    await wait(200);
    const notes = Notes.find().fetch();
    test.equal(notes.length, 2);

    await wait(500);
    const notesLater = Notes.find().fetch();
    test.equal(notesLater.length, 0);
  });

  Tinytest.addAsync('cache - regular pubsub -  with filter', async (test) => {
    Tracker.autorun(computation => {
      const sub = Meteor.subscribe('notes.filter', { title: 'stuff' }, {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
        sub.stop();
      }
    });

    await wait(200);
    const notes = Notes.find().fetch();
    test.equal(notes.length, 1);
    test.equal(notes[0].title, 'stuff')

    await wait(500);
    const notesLater = Notes.find().fetch();
    test.equal(notesLater.length, 0);
  });

  Tinytest.addAsync('cache - .once -  with filter', async (test) => {
    Tracker.autorun(computation => {
      const sub = Meteor.subscribe('notes.filter', { title: 'stuff' }, {cacheDuration: 0.5});
      if (sub.ready()) {
        computation.stop();
        sub.stop();
      }
    });

    await wait(200);
    const notes = Notes.find().fetch();
    test.equal(notes.length, 1);
    test.equal(notes[0].title, 'stuff')

    await wait(500);
    const notesLater = Notes.find().fetch();
    test.equal(notesLater.length, 0);
  });

  Tinytest.addAsync('cache - regular pubsub -  custom cacheDuration', async (test) => {
    await wait(101);
    await Meteor.callAsync('resetNotes');

    let notes;
    Tracker.autorun(computation => {
      const sub = Meteor.subscribe('notes.all', {cacheDuration: 0.25});
      if (sub.ready()) {
        computation.stop();
        notes = Notes.find().fetch();
        sub.stop();
      }
    });

    await wait(50);
    test.equal(notes.length, 2)

    await wait(251);
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
  Tinytest.addAsync('cache - .once - succesful', async (test) => {
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
      const result = await Meteor.callAsync('insertThing', {text: 'yo', num: 3 });
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
      await Meteor.callAsync('insertThing', { text: 'hi', num: 10 })
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
      await Meteor.callAsync('insertThing', { text: 'hi', num: 10 })
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
      const things = await Meteor.callAsync('fetchThings');

      test.equal(things.length, 1)
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
      const things = await Meteor.callAsync('fetchThings');

      test.equal(things.length, 1)
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
      const things = await Meteor.callAsync('fetchThings');

      test.equal(things.length, 1)
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
  Tinytest.addAsync('merge', async (test) => {
    const obj1 = {
      a: 1,
      b: {
        c: [
          { d: 2 },
          { e: 3 }
        ],
        f: [
          { g: 4 }
        ]
      },
      g: [1, 2]
    };

    const obj2 = {
      b: {
        c: [
          { h: 5 }
        ],
        f: [
          { i: 6 }
        ]
      },
      g: [2, 3, 4],
      j: [
        { k: 7 }
      ]
    };

    const lodashMerged = _merge(obj1, obj2);
    const merged = merge(obj1, obj2);

    test.equal(_isEqual(lodashMerged, merged), true);
  })
}
