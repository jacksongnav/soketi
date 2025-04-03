import { CacheManagerInterface } from './cache-manager-interface.js';
import { Log } from '../log.js';
import { MemoryCacheManager } from './memory-cache-manager.js';
import { RedisCacheManager } from './redis-cache-manager.js';
import { Server } from '../server.js';

export class CacheManager implements CacheManagerInterface {
    /**
     * The cache interface manager driver.
     */
    public driver: CacheManagerInterface;

    /**
     * Create a new cache instance.
     */
    constructor(protected server: Server) {
        if (server.options.cache.driver === 'memory') {
            this.driver = new MemoryCacheManager(server);
        } else if (server.options.cache.driver === 'redis') {
            this.driver = new RedisCacheManager(server);
        } else {
            Log.error('Cache driver not set.');
        }
    }

    /**
     * Check if the given key exists in cache.
     */
    has(key: string): Promise<boolean> {
        return this.driver.has(key);
    }

     /**
      * Check if the given key exists in cache.
      * Returns false-returning value if cache does not exist.
      */
    get(key: string): Promise<any> {
        return this.driver.get(key);
    }

     /**
      * Set or overwrite the value in the cache.
      */
    set(key: string, value: any, ttlSeconds: number): Promise<any> {
        return this.driver.set(key, value, ttlSeconds);
    }

    /**
     * Disconnect the manager's made connections.
     */
    disconnect(): Promise<void> {
        return this.driver.disconnect();
    }
}
