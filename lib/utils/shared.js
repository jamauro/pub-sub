import { EJSON } from 'meteor/ejson';

export const isEmpty = obj => [Object, Array].includes((obj || {}).constructor) && !Object.entries((obj || {})).length;

export const createKey = (data) => EJSON.stringify(data);
export const parseKey = (data) => EJSON.parse(data);

export const omit = (obj, keys) => {
  const newObj = {};

  for (let key in obj) {
    if (keys.includes(key)) continue;
    newObj[key] = obj[key];
  }

  return newObj;
};
