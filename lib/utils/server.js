import { isEmpty } from './shared';

const noop = () => {};

export const formatId = id => typeof id === 'object' ? new MongoID.ObjectID(id.toString()) : id; // support for Mongo ObjectId
export const includesOnly = (arr, allowed) => arr.every(item => allowed.includes(item)) && allowed.some(item => arr.includes(item));
export const extractIds = obj => Object.entries(obj).flatMap(([key, value]) =>
  ['_id', '$eq', '$in'].includes(key) ? (typeof value === 'string' ? [value] : (Array.isArray(value) ? value : extractIds(value))) : []
);

// used to filter out this.userId from a change stream selector because that won't scale
const _filterValue = (obj, valueToRemove) => {
  if (Array.isArray(obj)) {
    const result = [];
    for (const i in obj) {
      const newItem = _filterValue(obj[i], valueToRemove);
      if (newItem !== undefined) {
        result.push(newItem);
      }
    }
    return result.length ? result : undefined;
  }

  if (obj && typeof obj === 'object') {
    const newObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const newValue = _filterValue(obj[key], valueToRemove);

        if (['$or', '$and'].includes(key) && Array.isArray(newValue)) {
          if (newValue.length === 1) {
            Object.assign(newObj, newValue[0]);
          } else if (newValue.length > 1) {
            newObj[key] = newValue;
          }
        } else if (newValue !== undefined) {
          newObj[key] = newValue;
        }
      }
    }
    return Object.keys(newObj).length ? newObj : undefined;
  }

  // Return primitive, undefined if it matches valueToRemove
  return obj === valueToRemove ? undefined : obj;
}

export const removeValue = (obj, valueToRemove) => _filterValue(obj, valueToRemove) || {};

// used to convert the filter from a .find to a $match compatible with change streams. using for loops for the perf boost.
export const convertFilter = filter => {
  if (Array.isArray(filter)) {
    const result = [];
    for (const item of filter) result.push(convertFilter(item));
    return result;
  } else if (filter && typeof filter === 'object') {
    const result = {};
    for (const key in filter) {
      if (key === '$or' || key === '$and' || key === '$nor') {
        result[key] = convertFilter(filter[key]);
      } else {
        result[`fullDocument.${key}`] = filter[key];
      }
    }
    return result;
  } else {
    return filter;
  }
};

const hasPositionalOperator = str => /[$\d]/.test(str);
export const createProjection = modifier => {
  const projection = {};

  for (const key in modifier) {
    for (const field in modifier[key]) {
      if (hasPositionalOperator(field)) { // if it has a positional operator, just get the top level field so we can merge correctly
        projection[field.split('.')[0]] = 1
      } else {
        projection[field] = 1;
      }
    }
  }

  return  { projection };
};

// used to merge documents added by the low-level publish API into the final fetch result set
export const mergeDocIntoFetchResult = (doc, fetchResult) => {
  const { docs: existingDocs } = fetchResult[doc.collectionName];
  const newDoc = { _id: doc._id, ...doc.attrs };

  if (existingDocs) {
    const duplicatedDoc = existingDocs.find(o => o._id === newDoc._id);

    // We do not implement deep merge logic here to avoid performance issues
    if (duplicatedDoc) {
      const mergedDoc = { ...duplicatedDoc, ...newDoc };

      fetchResult[doc.collectionName].docs = [
        ...existingDocs.filter(o => o._id !== newDoc._id),
        mergedDoc,
      ];
    } else {
      fetchResult[doc.collectionName].docs = [...existingDocs, newDoc];
    }
  } else {
    fetchResult[doc.collectionName].docs = [newDoc];
  }

  return fetchResult;
};

export const overrideLowLevelPublishAPI = (methodInvocation, customAddedDocuments) => {
  // handle documents added with the this.added() custom low-level publish API
  methodInvocation.added = (collectionName, _id, attrs) => customAddedDocuments.push({ collectionName, _id, attrs });

  // prevent errors when these functions are called inside the original publish handler
  ['changed', 'removed', 'ready', 'onStop', 'error', 'stop'].forEach(name => methodInvocation[name] = noop);

  return;
};
