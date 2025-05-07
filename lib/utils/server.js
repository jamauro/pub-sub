import { Mongo, MongoInternals } from 'meteor/mongo';
import { MongoID } from 'meteor/mongo-id';
import { isEmpty, omit } from './shared';

const { ObjectId } = MongoInternals?.NpmModules.mongodb.module || {};

const noop = () => {};
const isPOJO = obj => obj !== null && typeof obj === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(obj));

///  support for Mongo ObjectId
export const formatId = id => typeof id === 'object' ? new MongoID.ObjectID(id._str || id.toHexString?.()) : id;
export const isObjectIdCollection = collection => collection._makeNewID?.toString().includes('ObjectID');
export const convertObjectId = o => { // converts from Mongo ObjectId to Meteor ObjectID and vice versa
  if (Array.isArray(o)) {
    return o.map(convertObjectId);
  }

  if (o instanceof Mongo.ObjectID) {
    return new ObjectId(o.valueOf());
  }

  if (o instanceof ObjectId) {
    return new MongoID.ObjectID(o.toHexString());
  }

  if (isPOJO(o)) {
    const newObj = {};

    for (const key in o) {
      const v = o[key];

      if (v instanceof Mongo.ObjectID) {
        newObj[key] = new ObjectId(v.valueOf());
      } else if (v instanceof ObjectId) {
        newObj[key] = new MongoID.ObjectID(v.toHexString());
      } else if (typeof v === 'object' && v !== null) {
        newObj[key] = convertObjectId(v);
      } else {
        newObj[key] = v;
      }
    }

    return newObj;
  }

  return o;
};
///

export const includesOnly = (arr, allowed) => arr.every(item => allowed.includes(item)) && allowed.some(item => arr.includes(item));
export const extractIds = obj => Object.entries(obj).flatMap(([key, value]) =>
  ['_id', '$eq', '$in'].includes(key) ? (typeof value === 'string' ? [value] : (Array.isArray(value) ? value : extractIds(value))) : []
);

export const trim = (arr, skip = 0, limit) => {
  if (skip >= arr.length) return [];
  if (limit <= 0) return [];

  return arr.slice(skip, Math.min(skip + limit, arr.length));
}

export const getCursor = (cursor, args) => {
  const { collectionName, selector: filter, options } = cursor._cursorDescription;
  const { sort, limit } = options;
  const defaults = { collectionName, filter, options, update: false };

  if (!sort || !limit) {
    return { cursor, ...defaults };
  }

  const [[ field, direction] = [] ] = Object.entries(sort || {});
  const shouldOmit = field in filter;

  // if the field we're paginating by, e.g. updatedAt is passed into the filter, we want to omit it from being watched by a change stream but we still use it for the cursor.fetch
  if (shouldOmit) {
    return { cursor, ...defaults, filter: omit(filter, [field]), update: true };
  }

  // at this point, we need update the query to include the sort field for pagination with the correct sort order
  // this is what allows the nicer syntax where we don't have to include it in the original cursor we defined
  const operator = direction === -1 ? '$lt' : '$gt';
  const value = args[0][field];
  const query = { ...filter, ...(value && { [field]: { [operator]: value }}) };
  const collection = Mongo.getCollection(collectionName);

  return { cursor: collection.find(query, options), ...defaults, update: !!value };
};

export const matchesFilter = (doc, filter) =>
  Object.entries(filter).every(([key, value]) =>
    key === '_id'
      ? value.$in ? value.$in.includes(doc._id) : doc._id === value
      : doc[key] === value
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

export const buildProjection = projection => {
  if (isEmpty(projection)) {
    return;
  }

  const project = {
    operationType: 1,
    ns: 1,
    documentKey: 1,
  }

  for (const p in projection) {
    const value = projection[p];

    project[`fullDocument.${p}`] = value;
    project[`updateDescription.updatedFields.${p}`] = value;
    project[`updateDescription.removedFields.${p}`] = value;
    project[`updateDescription.truncatedArrays.${p}`] = value;
  }

  return project;
}

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
