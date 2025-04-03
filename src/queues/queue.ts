import { JobData } from '../webhook-sender.js';
import { Log } from '../log.js';
import { QueueInterface } from './queue-interface.js';
import { RedisQueueDriver } from './redis-queue-driver.js';
import { SqsQueueDriver } from './sqs-queue-driver.js';
import { SyncQueueDriver } from './sync-queue-driver.js';
import { Server } from '../server.js';

export class Queue implements QueueInterface {
    /**
     * The Queue driver.
     */
    public driver: QueueInterface;

    /**
     * Initialize the queue.
     */
    constructor(protected server: Server) {
        if (server.options.queue.driver === 'sync') {
            this.driver = new SyncQueueDriver(server);
        } else if (server.options.queue.driver === 'redis') {
            this.driver = new RedisQueueDriver(server);
        } else if (server.options.queue.driver === 'sqs') {
            this.driver = new SqsQueueDriver(server);
        } else {
            Log.error('No valid queue driver specified.');
        }
    }

    /**
     * Add a new event with data to queue.
     */
    addToQueue(queueName: string, data?: JobData): Promise<void> {
        return this.driver.addToQueue(queueName, data);
    }

    /**
     * Register the code to run when handing the queue.
     */
    processQueue(queueName: string, callback: CallableFunction): Promise<void> {
        return this.driver.processQueue(queueName, callback);
    }

    /**
     * Clear the queues for a graceful shutdown.
     */
    disconnect(): Promise<void> {
        return this.driver.disconnect();
    }
}
