# PubSub

`jam:pub-sub` brings four key features to Meteor apps:

1. Method-based publish / subscribe
2. Change Streams-based publish / subscribe + server-side data caching
3. Subscription caching
4. Configuring server state (optional)

## Method-based publish / subscribe
Meteor's traditional `publish / subscribe` is truly wonderful. However, there is a cost to pushing updates reactively to all connected clients – it's resource intensive and will eventually place limits on your ability to scale your app.

One way to reduce the need for the traditional `publish / subscribe` is to fetch the data via a `Meteor Method` but there's a big problem here: the data **won't** be automatically merged into Minimongo and you completely lose Meteor's magical reactivity. Minimongo is great to work with and makes things easy as the source of truth on the client. Without it, you'll need to create your own stores on the client and essentially duplicate Minimongo.

With `jam:pub-sub`, you use `Meteor.publish.once` and the same `Meteor.subscribe` to have the data fetched via a Meteor Method and merged automatically in Minimongo so you can work with it as you're accustomed to. It also automatically preserves reactivity for the user when they make database writes. Note that these writes will **not** be broadcast in realtime to all connected clients by design but in many cases you might find that you don't need that feature of Meteor's traditional `publish / subscribe`.

## Change Streams-based publish / subscribe
**`Beta`**

With `jam:pub-sub` and MongoDB Change Streams, you can preserve Meteor's magical reactivity for all clients while opting out of the traditional `publish / subscribe` and its use of the `oplog`. Use `Meteor.publish.stream` instead of using `Meteor.publish` and subscribe using the same `Meteor.subscribe` on the client.

**Important**: Change Streams will work best when the filter you use can be shared. To that end, if you have a publication that includes a `userId`, this package will filter out that condition when setting up the Change Stream because it will result in too many unique change streams. As an example, lets say you have this publication:

```js
Meteor.publish.stream('todos', function() {
  return Todos.find({
    $or: [
      { isPrivate: false },
      { owner: this.userId }
    ]
  });
});
```

When this publication is invoked, it will fetch all the `Todos` that match the filter above and then begin watching a Change Stream with this filter:
```js
  { isPrivate: false }
```

A good rule of thumb: if you have a filter than relies on `this.userId`, you should use `.once`. If needed, you can split a compound publication into two publications, using a `.stream` with a filter than can be shared and a `.once` for the `userId`:

```js
Meteor.publish.stream('todos.public', function() {
  return Todos.find({ isPrivate: false });
});

Meteor.publish.once('todos.private', function() {
  return Todos.find({ isPrivate: true, owner: this.userId });
});
```

The data will be merged correctly into Minimongo so you can keep one compound filter there if you'd like.

**Note**: In most cases, you'd likely benefit the most from using `Meteor.publish.once` anywhere you can and using `Meteor.publish.stream` only when you really need it and with a filter than can be shared.

**Note**: If you decide to entirely opt-out of using the traditional `Meteor.publish`, then you'll also want to disable the `oplog` entirely &mdash; add the `disable-oplog` package with `meteor add disable-oplog`.

**Note**: Exclusion projections are not supported at this time. Use inclusion projections, e.g. `{ something: 1 }`

At the moment, this feature is considered in a `beta` state. Based on previous [Change Streams experiments](https://github.com/meteor/meteor/discussions/11842#discussioncomment-4061112) by the Meteor Community, it seems that using Change Streams as a wholesale replacement for the traditional `publish / subscribe` could "just work". However, in practice it may be a "Your Mileage May Vary" type of situation depending on the frequency of writes, number of connected clients, how you model your data, and how you set up the cursors inside of `Meteor.publish.stream`. With that said, if you're interested in this feature, I'd encourage you to try it out and share your findings.

#### Caching `.stream` data on the server
By default, the intial set of documents requested by a `.stream` are cached and kept in sync as data changes. For example, let's say you set up a stream for a chat room. When the first person connects, they'll fetch the data for the room, e.g. the most recent 20 messages based on your `sort ` and `limit`, and establish a change stream for the room.

```js
Meteor.publish.stream('messages.room', function({ roomId, sort, limit }) {
  // check the data
  return Messages.find({ roomId }, { sort, limit });
});
```

As new messages are inserted / updated / deleted, that set of the 20 most recent messages will be kept in sync so that when others join the room, they'll pull directly from the cache instead of hitting the database. As users scroll back through the message history, the historical documents will *not* be cached to avoid expending server resources.

So instead of the traditional Meteor behavior of keeping *all* state for every client + 1 for the observer, you'll be only keeping the 20 most recent documents. This should be a big help in freeing up server and db resources and reducing latency.

## Subscription caching
Normally, when a user moves between routes or components, the subscriptions will be stopped. When a user is navigating back and forth in your app, each time will result in a re-subscribe which means more spinners, a slower experience, and is generally a waste.

By caching your subscriptions, you can create a better user experience for your users. Since the subscription itself is being cached, the data in Minimongo will be updated in the background until the `cacheDuration` expires for that subscription at which point it will be stopped and the data will be removed from Minimongo as expected.

## Configuring server state
You can configure the amount of state you want to keep on the server by setting `serverState`. It can be one of `auto | standard | minimal | none`. By default, it's set to `auto`.

`Note`: The `users` and `roles` collections are excluded from the below. They will use the standard Meteor behavior.

`auto`
* If you are exclusively using `.stream`s for a collection, it will disable Meteor's mergebox and only keep the set of documents as detailed above in [Caching `.stream` data on the server](#Caching-.stream-data-on-the-server). The tradeoff we're making here is substanially reduced server memory and CPU usage for potentially higher bandwidth.
* If you are only using traditional publications, no changes will be made from the current behavior.

`standard`
* Preserves the standard Meteor behavior of keeping state for all clients + 1 for the observer for publications and diffing oplog data.

`minimal`
* Reduces server state by only keeping `_id`s when able for a collection. See [`NO_MERGE`](https://docs.meteor.com/api/meteor.html#no-merge) for more info.
* `.stream`s will continue to keep the set of documents as detailed above in [Caching `.stream` data on the server](#Caching-.stream-data-on-the-server)

`none`
* Does not keep any server state. Disables mergebox completely. See [`NO_MERGE_NO_HISTORY`](https://docs.meteor.com/api/meteor.html#no-merge-no-history) for more info.

## Usage

### Add the package to your app
`meteor add jam:pub-sub`

### Define a Method-based publication
Define a publication using `Meteor.publish.once` and subscribe just as you do currently. `Meteor.publish.once` expects you to return a cursor or an array of cursors just like `Meteor.publish`.

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

**Important**: when naming your publications be sure to include the collection name(s) in it. This is generally common practice and this package relies on that convention. If you don't do this and you're caching the subscription, Minimongo data may be unexpectedly removed or retained when the subscription stops. It's recommended that you follow this convention for all publications including `Meteor.publish`. Here are some examples of including the collection name in the publication name:
```js
// the name you assign inside Mongo.Collection should be in your publication name(s), in this example 'notes'
const Notes = new Mongo.Collection('notes')

// as long as it appears somewhere in your publication name, you're good to go. here are some examples:
Meteor.publish.once('notes');
Meteor.publish.once('notes.all');
Meteor.publish.once('notes/all');
Meteor.publish.once('allNotes');
```

It also works just as you'd expect for an array of cursors:

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

### Define a Change Streams-based publication
Define a publication using `Meteor.publish.stream` and subscribe just as you do currently. `Meteor.publish.stream` expects you to return a cursor or an array of cursors just like `Meteor.publish`.

```js
// server
Meteor.publish.stream('notes.all', function() {
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
That's it. By using `Meteor.publish.stream`, any database writes to the `Notes` collection will be sent reactively to **all** connected clients just as with `Meteor.publish`.

#### Setting the `maxPoolSize` for Change Streams
`maxPoolSize` defaults to `100` which may not need adjusting. If you need to adjust it, you can set it in [Meteor.settings](https://docs.meteor.com/api/collections.html#mongo_connection_options_settings) like this:
```js
{
  //...//
  "packages": {
    "mongo": {
      "options": {
        "maxPoolSize": 200 // or whatever is appropriate for your application
      }
    }
  }
  // ... //
}
```

### Turn on subscription caching
With `jam:pub-sub`, you can enable subscription caching globally or at a per-subscription level. Subscription caching is turned off by default to preserve the current behavior in Meteor. Any subscription can be cached, regardless of how it's published.

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

**Note**: the rest of the [Meteor.subscribe](https://docs.meteor.com/api/pubsub.html#Meteor-subscribe) API (e.g. `onStop`, `onReady`) works just as you'd expect.

**Note**: Because the data will remain in Minimongo while the subscription is cached, you should be mindful of your Minimongo `.find` selectors. Be sure to use specific selectors to `.find` the data you need for that particular subscription. This is generally considered [best practice](https://guide.meteor.com/data-loading#fetching) so this is mainly a helpful reminder.

#### Infinite duration
You can set a subscription so that it stays alive for the user's session by setting `cacheDuration: Infinity`. You'll likely want a good reason for doing so and it'd probably be wise to limit its use to `.once` publications. A potentially good use case would be for some particular current user info that you want to keep cached in minimongo.

### Infinite scroll / pagination with `.stream` and `.once`
In general, Mongo recommends using range-based pagination rather than using `skip` and `limit`, which can be slow. Both ways are shown below.

`Note:` `.stream` can be swapped for `.once` in these examples. It depends on the needs of your app.
`Note:` we’re using svelte in these examples but you can use your frontend of choice.

#### Set up the client

**Infinite scroll**

```js
const limit = 10;
let max = limit;
let sort = { updatedAt: -1 };
let updatedAt;

$m: sub = Meteor.subscribe('todos.shared', { updatedAt, sort, limit }); // we don't want to pass in a dynamic limit when we filter using updatedAt, that way we ensure we fetch at most whatever the limit is set to

$m: todos = Todos.find({ isPrivate: false }, { sort, limit: max }).fetch(); // we want a dynamic limit here

function next() {
  updatedAt = todos.at(-1)?.updatedAt; // get the last updatedAt so we can use it for our publication filter
  max += limit;
}
```

**Pagination**

Same set up as above but we introduce `skip`  on the client only and tweak the `next()` function.

```js
// max, limit, sort, updatedAt remain the same as the infinite scroll example above
let skip = 0;

$m: sub = Meteor.subscribe('todos.shared', { updatedAt, sort, limit });

$m: todos = Todos.find({ isPrivate: false }, { sort, skip, limit }).fetch(); // if you're not caching the subscription, you'll want to remove skip here

function next() {
  updatedAt = todos.at(-1)?.updatedAt;
  skip += limit;
}
```

#### Set up your publication on the server
The publication is the same for both of the above client setups:

```js
Meteor.publish.stream('todos.shared', function({ updatedAt, sort, limit }) {
  check(updatedAt, Match.Maybe(Date));
  check(sort, { updatedAt: Number });
  check(limit, Match.Maybe(Number));

  return Todos.find({ isPrivate: false }, { sort, limit }); // will paginate efficiently by updatedAt automatically
});
```

When there's a value for `updatedAt`, it will automatically be included in the filter because we're sorting by that same field. Alternatively, you can explicitly set it in the filter if you like:
```js
// same set up as the above Meteor.publish.stream with these tweaks
const operator = sort.updatedAt === -1 ? '$lt' : '$gt';

return Todos.find(
  { isPrivate: false, ...(updatedAt && {updatedAt: {[operator]: updatedAt}}) },
  { sort, limit }
);
```

Either way, the result will be the same. Fast, efficient pagination without using `skip` when fetching the data from Mongo.

#### Flipping the sort direction
If you wanted to allow flipping the sort direction, you can add a function like this on the client:
```js
function flipSort() {
    // to clean up minimongo as expected, you'll want to do this instead of mutating sort.updatedAt directly, e.g. sort.updatedAt = -sort.updatedAt
    sort = { updatedAt: -sort.updatedAt }
    // we'll want to reset these two
    max = limit;
    updatedAt = undefined;
  }
```

#### Pagination with go-to-page using `skip`
If your app needs to be able to go to a specific page when paginating, here's one way to approach it. The UX  below reveals the pages as your user goes to the next so they can easily jump to any page they've previously been to rather than laying all the pages out initially for them to randomly jump to.


```js
let page = 1;
let pages = new Set([page]);
const total = 10; // you'd probably fetch this number from the db initially or use a reactive counter
const maxPage = Math.round(total / limit);

$: skip = (page - 1) * limit;
$m: sub = Meteor.subscribe('todos.shared', { sort, skip, limit });

$m: todos = Todos.find({ isPrivate: false }, { sort, skip, limit }).fetch(); // if you're not caching the subscription, you'll want to remove skip here

/* if you didn't want to fetch the total, you could do something like this instead and then make some adjustments to your template as needed to support it
  $m: if (page !== 1 && sub.ready() && !todos.length) {
    maxPage = page;
  }
*/

function prev() {
  if (page > 1) {
    page--;
  }
}

function next() {
  if (page < maxPage) {
    page++;
    pages = pages.add(page);
  }
}

function goToPage(p) {
  if (page === p) return;

  page = p;
}

function flipSort() {
  sort = { updatedAt: -sort.updatedAt }
  page = 1;
}
```
```html
  <button on:click={prev} disabled={page === 1}>&larr;</button>
  <button on:click={next} disabled={page === maxPage}>&rarr;</button>
  {#each [...pages] as p}
    <button class:current={page === p} on:click={() => goToPage(p)}>{p}</button>
  {/each}
```

```js
// on the server
Meteor.publish.stream('todos.shared', function({ sort, skip, limit }) {
  check(sort, { updatedAt: Number });
  check(skip, Match.Maybe(Number));
  check(limit, Match.Maybe(Number));

  return Todos.find({ isPrivate: false }, { sort, skip, limit });
});
```

`Note`: remember, if you prefer not to cache all the data on the client while paginating and have the data fetched for each page but still cache your other subscriptions, you can always turn off caching for a particular subscription by passing in `{ cache: false }` as the last argument to `Meteor.subscribe`

### Clearing the cache
On the client, each individual subcription will be automatically removed from the cache when its `cacheDuration` elapses.

On the server, the cache for a `.stream` will be cleared when there are no longer any clients subscribed to it.

Though it shouldn't be necessary, you can programmatically clear all cached subscriptions and / or the server cache with:

```js
import { PubSub } from 'meteor/jam:pub-sub';

PubSub.clearCache();
```

## Configuring (optional)
The package is intended to be nearly zero config needed, but there is some flexibility in how you use it.

`Note`: You'd likely benefit from either caching all subscriptions by setting `cache: true` or at a minimum caching some.

Here are the defaults:
```js
const config = {
  cache: false, // globally turn subscription caching on or off, off by default.
  cacheDuration: 1 * 60, // globally set the cacheDuration in seconds, 1 min is the default.
  serverState: 'auto', // configure how much state you want to keep on the server
  debug: Meteor.isDevelopment // will provide some console.logs to help make sure you have things set up as you expect
};
````

To change the defaults, use:
```js
// put this in a file that's imported on both the client and server
import { PubSub } from 'meteor/jam:pub-sub';

PubSub.configure({
  // ... change the defaults here ... //
});
```

## Support

If you find this package valuable, I hope you'll consider [supporting](https://github.com/sponsors/jamauro) it. :) Maybe you pass on the cost to your client(s) or factor in the time it saved you and your team.
