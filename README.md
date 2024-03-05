# PubSub

`jam:pub-sub` brings two key features to Meteor apps:

1. **Method-based publish / subscribe**
2. **Subscription caching**

**Important**: This package expects that you'll use the promise-based `*Async` Meteor collection methods introduced in `v2.8.1`.

## Method-based publish / subscribe
Meteor's traditional `publish / subscribe` is truly wonderful. However, there is a cost to pushing updates reactively to all connected clients – it's resource intensive and will eventually place limits on your ability to scale your app.

One way to reduce the need for the traditional `publish / subscribe` is to fetch the data via a `Meteor Method` but there's a big problem here: the data **won't** be automatically merged into Minimongo and you completely lose Meteor's magical reactivity. Minimongo is great to work with and makes things easy as the source of truth on the client. Without it, you'll need to create your own stores on the client and essentially duplicate Minimongo.

With `jam:pub-sub`, you use `Meteor.publish.once` and the same `Meteor.subscribe` to have the data fetched via a Meteor Method and merged automatically in Minimongo so you can work with it as you're accustomed to. It also automatically preserves reactivity for the user when they make database writes. Note that these writes will **not** be broadcast in realtime to all connected clients by design but in many cases you might find that you don't need that feature of Meteor's traditional `publish / subscribe`.

## Subscription caching
Normally, when a user moves between routes or components, the subscriptions will be stopped. When a user is navigating back and forth in your app, each time will result in a re-subscribe which means more spinners, a slower experience, and is generally a waste.

By caching your subscriptions, you can create a better user experience for your users. Since the subscription itself is being cached, the data in Minimongo will be updated in the background until the `cacheDuration` expires for that subscription at which point it will be stopped and the data will be removed from Minimongo as expected.

## Usage

### Add the package to your app
`meteor add jam:pub-sub`

### Define a publication using `Meteor.publish.once` and subscribe just as you do currently
Just like `Meteor.publish`, `Meteor.publish.once` expects you to return a cursor or an array of cursors.

```js
// server
Meteor.publish.once('notes.all', function() {
  return Notes.find();
});
```

```js
// client
// Since each view layer (Blaze, React, Svelte, Vue, etc) has a different way of using `Tracker.autorun`, I've omitted it for brevity. You'd subscribe just as you do currently in your view layer of choice.
Meteor.subscribe('notes.all')

// work with the Notes collection in Minimongo as you're accustomed to
Notes.find().fetch();
```
That's it. By using `Meteor.publish.once`, it will fetch the data initally and automatically merge it into Minimongo. Any database writes to the `Notes` collection will be sent reactively to the user that made the write.

**Important**: when naming your publications be sure to include the collection name(s) in it. This is generally common practice and this package relies on that convention.

It works just as you'd expect for an array of cursors:

```js
// server
Meteor.publish.once('notes.todos.all', function() {
  return [Notes.find(), Todos.find()];
});
```

```js
// client
Meteor.subscribe('notes.todos.all');

// work with the Notes collection in Minimongo as you're accustomed to
Notes.find().fetch();

// work with the Todos collection in Minimongo as you're accusomted to
Todos.find().fetch();
```

Inside `Meteor.publish.once`, `this.userId` and [this.added](https://docs.meteor.com/api/pubsub.html#Subscription-added) can still be used. The added document will be included in the final result data. The rest of the low-level `publish` API will be disregarded, as they no longer fit into the context of a Method-based data fetch.

```js
Meteor.publish.once('notes.all', function() {
  // ... //
  const userId = this.userId;

  this.added('notes', _id, fields);
  // ... //
  return Notes.find();
})
```

### Turn on subscription caching
With `jam:pub-sub`, you can enable subscription caching globally or at a per-subscription level. Subscription caching is turned off by default to preserve the current behavior in Meteor.

To enable subscription caching globally for every subscription:
```js
// put this in a file that's imported on the client at a minimum. it can be used isomorphically but the configuration only applies to the client.
import { PubSub } from 'meteor/jam:pub-sub';

PubSub.configure({
  cache: true // defaults to false
});
```

The global `cacheDuration` is set to `60 seconds` by default. This is from when the subscription was originally set to be stopped, i.e. when the component housing the subscription was destroyed because the user navigated away. If the user comes right back, then the cache will be used. If they don't, after `60 seconds`, the subscription cache will be removed. If you want to change the global `cacheDuration`, change it with a value in `seconds`:

```js
import { PubSub } from 'meteor/jam:pub-sub';

PubSub.configure({
  cacheDuration: 5 * 60 // sets the cacheDuration to 5 minutes. defaults to 1 min
});
```

You can also configure `cache` and `cacheDuration` for each individual subscription when you use `Meteor.subscribe`. For example:
```js
Meteor.subscribe('todos.single', _id, { cacheDuration: 30 }) // caches for 30 seconds, overriding the global default
Meteor.subscribe('notes.all', { cache: true }) // turns caching on, overriding the global default, and uses the global default cacheDuration
```

`Note`: the rest of the [Meteor.subscribe](https://docs.meteor.com/api/pubsub.html#Meteor-subscribe) API (e.g. `onStop`, `onReady`) works just as you'd expect.

`Note`: Because the data will remain in Minimongo while the subscription is cached, you should be mindful of your Minimongo `.find` selectors. Be sure to use specific selectors to `.find` the data you need for that particular subscription. This is generally considered [best practice](https://guide.meteor.com/data-loading#fetching) so this is mainly a helpful reminder.

### Clearing the cache
Each individual subcription will be automatically removed from the cache when its `cacheDuration` elapses.

Though it shouldn't be necessary, you can programmatically clear all cached subscriptions:

```js
import { PubSub } from 'meteor/jam:pub-sub';

PubSub.clearCache();
```
