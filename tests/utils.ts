import async from 'async';
import { Log } from '../src/log';
import { Server } from './../src/server';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from "crypto"

import bodyParser from 'body-parser';
import express from 'express';
import { ServerOptions } from '../src/types';
import PusherServer from 'pusher';
import { Options } from 'pusher-js';
import * as Pusher from 'pusher-js';
import PusherClient from 'pusher-js';
import { createConnection } from 'net';

export class Utils {
    public static wsServers: Server[] = [];
    public static httpServers: any[] = [];

    static appManagerIs(manager: string): boolean {
        return (process.env.TEST_APP_MANAGER || 'array') === manager;
    }

    static adapterIs(adapter: string) {
        return (process.env.TEST_ADAPTER || 'local') === adapter;
    }

    static queueDriverIs(queueDriver: string) {
        return (process.env.TEST_QUEUE_DRIVER || 'sync') === queueDriver;
    }

    static async isPortUsed(port: number, timeout: number = 5000): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let resolved = false; // Add a flag to track resolution
    
            const check = () => {
                if (resolved) { // Check if already resolved
                    return;
                }
    
                const socket = createConnection({ port, host: '127.0.0.1' }, () => {
                    socket.destroy();
                    if (!resolved) {
                        resolved = true;
                        resolve(true);
                    }
                });
    
                socket.on('error', (err: any) => {
                    socket.destroy();
                    if (!resolved) {
                        if (err.code === 'ECONNREFUSED') {
                            resolved = true;
                            resolve(false);
                        } else {
                            resolved = true;
                            reject(err);
                        }
                    }
                });
    
                if (Date.now() - startTime > timeout) {
                    console.log(`[DEBUG] Timeout reached for port ${port} after ${timeout}ms.`);
                    socket.destroy();
                    if (!resolved) {
                        resolved = true;
                        reject(new Error(`Timeout after ${timeout}ms`));
                    }
                } else {
                    if (!resolved) {
                        setTimeout(check, 100); // Check again after a delay.
                    }
                }
            };
    
            check();
        });
    }

    static async waitForPortsToFreeUp(): Promise<void> {
        const ports = [6001, 6002, 3001, 9601, 11002];
        const timeout = 5000;
        const interval = 500;
    
        const checkPorts = async () => {
            const results = await Promise.all(ports.map(port => this.isPortUsed(port, timeout)));
    
            if (results.every(result => !result)) {
                return; // All ports are free.
            } else {
                console.log('[DEBUG] Some ports are still in use. Retrying...');
                await new Promise(resolve => setTimeout(resolve, interval));
                await checkPorts(); // Recursive call to check again.
            }
        };
    
        await checkPorts();
    }

    static newServer(options: ServerOptions = {}, callback): any {
        console.log("Attempting to start server")
        options = {
            'cluster.prefix': uuidv4(),
            'adapter.redis.prefix': uuidv4(),
            'adapter.nats.prefix': uuidv4(),
            'appManager.array.apps.0.maxBackendEventsPerSecond': 200,
            'appManager.array.apps.0.maxClientEventsPerSecond': 200,
            'appManager.array.apps.0.maxReadRequestsPerSecond': 200,
            'metrics.enabled': true,
            'appManager.mysql.useMysql2': true,
            'cluster.port': parseInt((Math.random() * (20000 - 10000) + 10000).toString()), // random: 10000-20000
            'appManager.dynamodb.endpoint': 'http://127.0.0.1:8000',
            'cluster.ignoreProcess': false,
            'webhooks.batching.enabled': false, // TODO: Find out why batching works but fails tests
            'webhooks.batching.duration': 1,
            'appManager.cache.enabled': true,
            'appManager.cache.ttl': -1,
            ...options,
            'adapter.driver': process.env.TEST_ADAPTER || 'local',
            'cache.driver': process.env.TEST_CACHE_DRIVER || 'memory',
            'appManager.driver': process.env.TEST_APP_MANAGER || 'array',
            'queue.driver': process.env.TEST_QUEUE_DRIVER || 'sync',
            'rateLimiter.driver': process.env.TEST_RATE_LIMITER || 'local',
            'database.mysql.user': process.env.TEST_MYSQL_USER || 'testing',
            'database.mysql.password': process.env.TEST_MYSQL_PASSWORD || 'testing',
            'database.mysql.database': process.env.TEST_MYSQL_DATABASE || 'testing',
            'database.postgres.user': process.env.TEST_POSTGRES_USER || 'testing',
            'database.postgres.password': process.env.TEST_POSTGRES_PASSWORD || 'testing',
            'database.postgres.database': process.env.TEST_POSTGRES_DATABASE || 'testing',
            'queue.sqs.queueUrl': process.env.TEST_SQS_URL || 'http://localhost:4566/000000000000/test.fifo',
            'debug': process.env.TEST_DEBUG || false,
            'shutdownGracePeriod': 1_000,
        };

        try {
            return (new Server(options)).start((server: Server) => {
                this.wsServers.push(server);
    
                if (server.options.cache.driver === 'redis') {
                    server.cacheManager?.driver?.redisConnection?.flushdb().then(() => {
                        callback(server);
                    });
                } else {
                    callback(server);
                }
            });
        } catch (error) {
            console.error('Error starting server:', error);
        }
    }

    static newClonedServer(server: Server, options = {}, callback): any {
        return this.newServer({
            // Make sure the same prefixes exists so that they can communicate
            'adapter.redis.prefix': server.options.adapter.redis.prefix,
            'adapter.nats.prefix': server.options.adapter.nats.prefix,
            'cluster.prefix': server.options.cluster.prefix,
            'cluster.port': server.options.cluster.port,
            ...options,
        }, callback);
    }

    static newWebhookServer(requestHandler: (req: express.Request, res: express.Response, next?: express.NextFunction) => void, onReadyCallback: CallableFunction): any {
        let webhooksApp = express();

        webhooksApp.use(bodyParser.json());

        webhooksApp.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', '*');
            res.header('Access-Control-Allow-Headers', '*');
            next();
        });

        webhooksApp.post('*', requestHandler);

        let server = webhooksApp.listen(3001, () => {
            Log.successTitle('🎉 Webhook Server is up and running!');

            server.on('error', err => {
                console.log('Websocket server error', err);
            });

            this.httpServers.push(server);

            onReadyCallback(server);
        });
    }

    static flushWsServers(): Promise<void> {
        if (this.wsServers.length === 0) {
            return Promise.resolve();
        }

        return async.each(this.wsServers, (server: Server, serverCallback) => {
            server.stop().then(() => {
                serverCallback();
            });
        }).then(() => {
            this.wsServers = [];
        });
    }

    static flushHttpServers(): Promise<void> {
        if (this.httpServers.length === 0) {
            return Promise.resolve();
        }

        return async.each(this.httpServers, (server: any, serverCallback) => {
            server.close(() => {
                serverCallback();
            });
        }).then(() => {
            this.httpServers = [];
        });
    }

    static flushServers(): Promise<any> {
        return Promise.all([
            this.flushWsServers(),
            this.flushHttpServers(),
        ]);
    }

    static newClient(options?: Options, port = 6001, key = 'app-key', withStateChange = true): PusherClient {
        try {
            
            let defaultOptions: Options = {
                wsHost: '127.0.0.1',
                authEndpoint: '/',
                httpHost: '127.0.0.1',
                cluster: 'mt1',
                wsPort: port,
                wssPort: port,
                httpPort: port,
                httpsPort: port,
                forceTLS: false,
                disableStats: true,
                enabledTransports: ['ws'],
                ignoreNullOrigin: true,
            }

            const pusherOptions = { ...defaultOptions, ...options };
            /* @ts-ignore */
            let client = new Pusher(key, pusherOptions) as PusherClient
    
            if (withStateChange) {
                client.connection.bind('state_change', ({ current }) => {
                    if (current === 'unavailable') {
                        console.log('The connection could not be made. Status: ' + current);
                    }
                });
            }
    
            return client;
        } catch (e) {
            console.error('Error creating new client:', e);
            throw new Error('Failed to create a new Pusher client.');
        }
    }

    static newBackend(appId = 'app-id', key = 'app-key', secret = 'app-secret', port = "6001"): any {
        try {
            const test = new PusherServer({
                appId,
                key,
                cluster: 'mt1',
                secret,
                host: '127.0.0.1',
                port,
            });
            return test
        } catch (e) {
            console.error('Error creating new backend:', e);
        }
        
    }

    static newClientForPrivateChannel(clientOptions = {}, port = 6001, key = 'app-key', userData = {}): PusherClient {
        try {
            return this.newClient({
                authorizer: (channel, options) => ({
                    authorize: (socketId, callback) => {
                        callback(null, {
                            auth: this.signTokenForPrivateChannel(socketId, channel),
                        });
                    },
                }),
                userAuthentication: {
                    transport: "jsonp",
                    endpoint: '/',
                    customHandler: ({ socketId }, callback) => {
                        callback(null, {
                            auth: this.signTokenForUserAuthentication(socketId, JSON.stringify(userData), key),
                            user_data: JSON.stringify(userData),
                        });
                    },
                },
                cluster: "mt1",
                ...clientOptions,
            }, port, key);
        } catch (error) {
            console.error('Error creating client for private channel:', error);
            throw new Error('Failed to create a client for the private channel.');
        }
    }

    static newClientForEncryptedPrivateChannel(clientOptions = {}, port = 6001, key = 'app-key', userData = {}): PusherClient {
        return this.newClient({
            authorizer: (channel, options) => ({
                authorize: (socketId, callback) => {
                    const sharedSecret = this.newBackend().channelSharedSecret(channel.name); // Generate shared secret
                    callback(null, {
                        auth: this.signTokenForPrivateChannel(socketId, channel, key),
                        shared_secret: sharedSecret.toString('base64'), // Provide shared secret
                    });
                },
            }),
            userAuthentication: {
                transport: "jsonp",
                endpoint: '/',
                customHandler: ({ socketId }, callback) => {
                    callback(null, {
                        auth: this.signTokenForUserAuthentication(socketId, JSON.stringify(userData), key),
                        user_data: JSON.stringify(userData),
                    });
                },
            },
            cluster: "mt1",
            ...clientOptions,
        }, port, key);
    }

    static newClientForPresenceUser(user: any, clientOptions = {}, port = 6001, key = 'app-key', userData = {}): any {
        return this.newClient({
            authorizer: (channel, options) => ({
                authorize: (socketId, callback) => {
                    callback(null, {
                        auth: this.signTokenForPresenceChannel(socketId, channel, user, key),
                        channel_data: JSON.stringify(user),
                    });
                },
            }),
            userAuthentication: {
                transport: "jsonp",
                endpoint: '/',
                customHandler: ({ socketId }, callback) => {
                    callback(null, {
                        auth: this.signTokenForUserAuthentication(socketId, JSON.stringify(userData), key),
                        user_data: JSON.stringify(userData),
                    });
                },
            },
            cluster: "mt1",
            ...clientOptions,
        }, port, key);
    }

    static signTokenForPrivateChannel(
        socketId: string,
        channel: any,
        key = 'app-key',
        secret = 'app-secret'
    ): string {
        const stringToSign = `${socketId}:${channel.name}`;
        const hmac = createHmac('sha256', secret).update(stringToSign).digest('hex');

        return key + ':' + hmac;
    }

    static signTokenForPresenceChannel(
        socketId: string,
        channel: any,
        channelData: any,
        key = 'app-key',
        secret = 'app-secret'
    ): string {
        const stringToSign = `${socketId}:${channel.name}:${JSON.stringify(channelData)}`;
        const hmac = createHmac('sha256', secret).update(stringToSign).digest('hex');
    
        return `${key}:${hmac}`;
    }
    

    static signTokenForUserAuthentication(
        socketId: string,
        userData: string,
        key = 'app-key',
        secret = 'app-secret'
    ): string {
        console.log("signTokenForUserAuthentication called with:");
        console.log("  socketId:", socketId);
        console.log("  userData:", userData);
        console.log("  key:", key);
        console.log("  secret:", secret);
    
        const stringToSign = `${socketId}:${userData}`;
        const hmac = createHmac('sha256', secret).update(stringToSign).digest('hex');
        console.log("  hmac:", hmac);
    
        const finalToken = `${key}:${hmac}`;
        console.log("  finalToken:", finalToken);
    
        return finalToken;
    }

    static wait(ms): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    static randomChannelName(): string {
        return `channel-${Math.floor(Math.random() * 10000000)}`;
    }

    static shouldRun(condition): jest.It {
        return condition ? it : it.skip;
    }
}
