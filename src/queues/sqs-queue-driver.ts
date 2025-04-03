import async from 'async';
import { Consumer, ConsumerOptions } from 'sqs-consumer';
import { createHash } from 'crypto';
import { Job } from '../job.js';
import { JobData } from '../webhook-sender.js';
import { Log } from '../log.js';
import { QueueInterface } from './queue-interface.js';
import { Server } from '../server.js';
import { v4 as uuidv4 } from 'uuid';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

export class SqsQueueDriver implements QueueInterface {
    /**
     * The list of consumers with their instance.
     */
    protected queueWithConsumer: Map<string, Consumer> = new Map();

    /**
     * Initialize the Prometheus exporter.
     */
    constructor(protected server: Server) {
        //
    }

    /**
     * Add a new event with data to queue.
     */
    addToQueue(queueName: string, data: JobData): Promise<void> {
        return new Promise(resolve => {
            let message = JSON.stringify(data);

            let params = {
                MessageBody: message,
                MessageDeduplicationId: createHash('sha256').update(message).digest('hex'),
                MessageGroupId: `${data.appId}_${queueName}`,
                QueueUrl: this.server.options.queue.sqs.queueUrl,
            };

            const command = new SendMessageCommand(params);

            this.sqsClient().send(command).then(data => {
                if (this.server.options.debug) {
                    Log.successTitle('✅ SQS client published message to the queue.');
                    Log.success({ data, params, queueName });
                }
                resolve();
            }).catch(err => {
                Log.errorTitle('❎ SQS client could not publish to the queue.');
                Log.error({ err, params, queueName });
                resolve();
            });
        });
    }

    /**
     * Register the code to run when handing the queue.
     */
    processQueue(queueName: string, callback: CallableFunction): Promise<void> {
        return new Promise(resolve => {
            let handleMessage = ({ Body }: { Body: string; }) => {
                return new Promise<void>(resolve => {
                    callback(
                        new Job(uuidv4(), JSON.parse(Body)),
                        () => {
                            if (this.server.options.debug) {
                                Log.successTitle('✅ SQS message processed.');
                                Log.success({ Body, queueName });
                            }

                            resolve();
                        },
                    );
                });
            };

            let consumerOptions: ConsumerOptions = {
                queueUrl: this.server.options.queue.sqs.queueUrl,
                sqs: this.sqsClient(),
                batchSize: this.server.options.queue.sqs.batchSize,
                pollingWaitTimeMs: this.server.options.queue.sqs.pollingWaitTimeMs,
                ...this.server.options.queue.sqs.consumerOptions,
            };

            if (this.server.options.queue.sqs.processBatch) {
                consumerOptions.handleMessageBatch = (messages) => {
                    return Promise.all(messages.map(({ Body }) => handleMessage({ Body }))).then(() => {
                        //
                    });
            };
            } else {
                consumerOptions.handleMessage = handleMessage;
            }

            let consumer = Consumer.create(consumerOptions);

            consumer.start();

            this.queueWithConsumer.set(queueName, consumer);

            resolve();
        });
    }

    /**
     * Clear the queues for a graceful shutdown.
     */
    disconnect(): Promise<void> {
        return async.each([...this.queueWithConsumer], ([queueName, consumer]: [string, Consumer], callback) => {
            if (consumer.status.isRunning) {
                consumer.stop();
                callback();
            }
        });
    }

    /**
     * Get the SQS client.
     */
    protected sqsClient(): SQSClient {
        let sqsOptions = this.server.options.queue.sqs;

        return new SQSClient({
            apiVersion: '2012-11-05',
            region: sqsOptions.region || 'us-east-1',
            endpoint: sqsOptions.endpoint,
        });
    }
}
