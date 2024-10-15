## 0.3.0
* feat: improve Change Streams multiplexing
* feat: support for overlapping subscriptions on the same collection
* fix: preserve `options` in Mongo methods for Meteor 3.0+
* fix: support `async` publish handlers for `.once` and `.stream`
* fix: under-the-hood optimizations and simplification

## 0.2.5
* fix: improve converting filter for Change Streams

## 0.2.4
* fix: preserve default behavior when subscription `name` is `null` or `undefined`
* fix: bump `versionsFrom` to official Meteor 3.0 release

## 0.2.3
* fix: `Mongo.ObjectID` support for `Meteor.publish.once` and `Meteor.publish.stream`
* fix: filtering DDP messages
* fix: allow case-insensitive collection names

## 0.2.2
* fix: `react-meteor-data` subscription caching for regular `Meteor.publish` publications
* fix: `vue-meteor-tracker` subscription caching for regular `Meteor.publish` publications

## 0.2.1
* fix: excluding projections
* fix: unhandled promise rejection
* fix: check for duplicate publication name correctly for `Meteor.publish.stream`

## 0.2.0
* feat: Change Streams-based publications
* fix: correctly stop cached subscriptions that are subscribed to a `Meteor.publish` publication after initial cache is hit
* fix: under-the-hood optimizations

## 0.1.3
* fix: pass in `onStop` and `onReady` correctly to appease `audit-argument-checks`

## 0.1.2
* fix: extract object subscription arguments correctly

## 0.1.1
* fix: support for shorthand `_id` in db writes
* fix: under-the-hood optimizations

## 0.1.0
* initial version
