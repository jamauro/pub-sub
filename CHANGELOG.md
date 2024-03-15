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
