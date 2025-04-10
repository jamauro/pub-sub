export type ServerState = 'auto' | 'standard' | 'minimal' | 'none';

export interface Config {
  /**
   * Enables or disables caching globally.
   */
  cache: boolean;

  /**
   * Duration in seconds for which to cache subscriptions.
   */
  cacheDuration: number;

  /**
   * Controls the amount of server state retained.
   */
  serverState: ServerState;

  /**
   * Enables console debugging.
   */
  debug: boolean;
}

/**
 * The current PubSub config
 */
export const config: Config;

/**
 * Updates the PubSub config
 *
 * @param options - Partial config object.
 * @returns The updated config.
 */
export function configure(options: Partial<Config>): Config;

export declare function publishOnce(name: string, handler: (...args: any[]): { [collectionName: string]: object[] };
export declare function stream(name: string, handler: (...args: any[]) => void): void;

declare module 'meteor/meteor' {
  export namespace Meteor {
    /**
     * @summary Subscribe to a record set. Returns a handle that provides `stop()` and `ready()` methods.
     * @locus Client
     * @param {String} name Name of the subscription. Matches the name of the server's `publish()` call.
     * @param {EJSONable} [arg1,arg2...] Optional arguments passed to publisher function on server.
     * @param {Object|Function} [options] Optional. May include `onStop`, `onReady`, `cache`, and `cacheDuration`. If there is an error, it is passed as an argument to `onStop`. If a function is passed instead of an object, it is interpreted as an `onReady` callback.
     * @param {Function} [options.onStop] Optional. Called with no arguments when the subscription is stopped.
     * @param {Function} [options.onReady] Optional. Called with no arguments when the subscription is ready.
     * @param {Boolean} [options.cache] Optional. If true, the subscription will be cached. If false, it will not be cached. If not provided, the PubSub global config value will be used.
     * @param {Number} [options.cacheDuration] Optional. The duration in seconds for which the subscription will be cached. If not provided, the PubSub global config value will be used.
     * @returns {Meteor.SubscriptionHandle} A subscription handle that provides `stop()` and `ready()` methods.
     */
    function subscribe(name: string, ...args: any[]): Meteor.SubscriptionHandle;

    export namespace publish {
      /**
       * Publishes a record set once.
       * @param {string} name - The name of the record set.
       * @param {Function} handler - The function called on the server each time a client subscribes.
       * @returns {Object.<string, Array.<Object>>} An object containing arrays of documents for each collection. These will be automatically merged into Minimongo.
       */
      export const once: typeof publishOnce;

      /**
       * Stream a record set.
       * @param {string} name - The name of the record set.
       * @param {Function} handler - The function called on the server each time a client subscribes. Inside the function, `this` is the publish handler object. If the client passed arguments to
       * `subscribe`, the function is called with the same arguments.
       * @returns {void}
       */
      export const stream: typeof stream;
    }
  }
}



