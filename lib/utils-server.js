const noop = () => {};

export const includesOnly = (arr, allowed) => arr.every(item => allowed.includes(item)) && allowed.some(item => arr.includes(item));

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

// Used to merge documents added by the low-level publish API into the final fetch result set
export const mergeDocIntoFetchResult = (doc, fetchResult) => {
  const existingDocs = fetchResult[doc.collectionName];
  const newDoc = { _id: doc._id, ...doc.attrs };

  if (existingDocs) {
    const duplicatedDoc = existingDocs.find(o => o._id === newDoc._id);

    // We do not implement deep merge logic here to avoid performance issues
    if (duplicatedDoc) {
      const mergedDoc = { ...duplicatedDoc, ...newDoc };

      fetchResult[doc.collectionName] = [
        ...existingDocs.filter(o => o._id !== newDoc._id),
        mergedDoc,
      ];
    } else {
      fetchResult[doc.collectionName] = [...existingDocs, newDoc];
    }
  } else {
    fetchResult[doc.collectionName] = [newDoc];
  }

  return fetchResult;
};

export const overrideLowLevelPublishAPI = (methodInvocation, customAddedDocuments) => {
  // Handle documents added with the this.added() custom low-level publish API
  methodInvocation.added = (collectionName, _id, attrs) => customAddedDocuments.push({ collectionName, _id, attrs });

  // Prevent errors when these functions are called inside the original publish handler
  ['changed', 'removed', 'ready', 'onStop', 'error', 'stop'].forEach(functionName => {
    methodInvocation[functionName] = noop;
  });

  return;
};
