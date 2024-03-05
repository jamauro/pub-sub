import { EJSON } from 'meteor/ejson';

export const subsCache = {
  // 'stringified-name-args': { handle, duration, refreshedAt }
};

export const generateCacheKey = ({name, args}) => EJSON.stringify({name, args});
export const findSub = key => subsCache[key];

export const getSubRemaining = key => {
  const cachedSub = findSub(key);
  if (!cachedSub) {
    return 0;
  }

  const remaining = cachedSub.duration - (Date.now() - cachedSub.refreshedAt);

  return remaining > 0 ? remaining : 0;
};

export const updateSub = ({ key, ...args }) => {
  const cachedSub = findSub(key);
  if (!cachedSub) {
    return;
  }

  return Object.assign(cachedSub, { ...args });
};

export const addSub = ({ key, handle, duration, active }) => {
  return subsCache[key] = {
    handle,
    duration,
    active,
    refreshedAt: new Date()
  };
};

export const removeSub = key => delete subsCache[key];

export const clearCache = () => {
  for (const key in subsCache) {
    const { handle } = subsCache[key];
    handle?.stop();
    delete subsCache[key];
  }
  return;
}
