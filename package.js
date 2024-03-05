Package.describe({
  name: 'jam:pub-sub',
  version: '0.1.0',
  summary: 'Method-based publish / subscribe and subscription caching',
  git: 'https://github.com/jamauro/pub-sub.git',
  documentation: 'README.md'
});

Package.onUse(function(api) {
  api.versionsFrom(['2.8.1', '3.0-alpha.19']);
  api.use(['ecmascript', 'check', 'tracker', 'random', 'ejson', 'mongo-id'], 'client');
  api.use(['ecmascript', 'check', 'mongo', 'ddp-client'], 'server');
  api.use('zodern:types@1.0.11');
  api.mainModule('client.js', 'client');
  api.mainModule('server.js', 'server');
});

Package.onTest(function(api) {
  api.use('ecmascript');
  api.use('tinytest');
  api.use('mongo');
  api.use('tracker');
  api.use('jam:pub-sub');

  Npm.depends({
    lodash: '4.17.15',
  });

  api.mainModule('tests.js');
});
