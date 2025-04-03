import { App } from './app';
import async from 'async';
import { EncryptedPrivateChannelManager } from './channels';
import { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { Log } from './log';
import { Namespace } from './namespace';
import { PresenceChannelManager } from './channels';
import { PresenceMemberInfo } from './channels/presence-channel-manager';
import { PrivateChannelManager } from './channels';
import { PublicChannelManager } from './channels';
import { PusherMessage, uWebSocketMessage } from './message';
import { Server } from './server';
import { Utils } from './utils';
import { WebSocket } from 'uWebSockets.js';
import { WebSocketUserData } from './types';

import Pusher from 'pusher';
import { createHmac } from 'crypto';

export class WsHandler {
    /**
     * The manager for the public channels.
     */
    protected publicChannelManager: PublicChannelManager;

    /**
     * The manager for the private channels.
     */
    protected privateChannelManager: PrivateChannelManager;

    /**
     * The manager for the encrypted private channels.
     */
    protected encryptedPrivateChannelManager: EncryptedPrivateChannelManager;

    /**
     * The manager for the presence channels.
     */
    protected presenceChannelManager: PresenceChannelManager;

    /**
     * Initialize the Websocket connections handler.
     */
    constructor(protected server: Server) {
        this.publicChannelManager = new PublicChannelManager(server);
        this.privateChannelManager = new PrivateChannelManager(server);
        this.encryptedPrivateChannelManager = new EncryptedPrivateChannelManager(server);
        this.presenceChannelManager = new PresenceChannelManager(server);
    }

    /**
     * Handle a new open connection.
     */
    onOpen(ws: WebSocket<WebSocketUserData>): any {
        if (this.server.options.debug) {
            Log.websocketTitle('👨‍🔬 New connection:');
            Log.websocket({ ws: ws.getUserData() }); // Log the custom user data
        }

        const user = ws.getUserData(); // Get the user data object

        user.sendJson = (data) => {
            try {
                ws.send(JSON.stringify(data));

                this.updateTimeout(ws);

                if (user.app) {
                    this.server.metricsManager.markWsMessageSent(user.app.id, data);
                }

                if (this.server.options.debug) {
                    Log.websocketTitle('✈ Sent message to client:');
                    Log.websocket({ ws: user, data }); // Log the custom user data
                }
            } catch (e) {
                //
            }
        };

        user.id = this.generateSocketId();
        user.subscribedChannels = new Set();
        user.presence = new Map<string, PresenceMemberInfo>();

        if (this.server.closing) {
            user.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server is closing. Please reconnect shortly.',
                },
            });

            return ws.end(4200);
        }

        this.checkForValidApp(ws).then(validApp => {
            if (!validApp) {
                user.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4001,
                        message: `App key ${user.appKey} does not exist.`,
                    },
                });

                return ws.end(4001);
            }

            user.app = validApp.forWebSocket();

            this.checkIfAppIsEnabled(ws).then(enabled => {
                if (!enabled) {
                    user.sendJson({
                        event: 'pusher:error',
                        data: {
                            code: 4003,
                            message: 'The app is not enabled.',
                        },
                    });

                    return ws.end(4003);
                }

                this.checkAppConnectionLimit(ws).then(canConnect => {
                    if (!canConnect) {
                        user.sendJson({
                            event: 'pusher:error',
                            data: {
                                code: 4100,
                                message: 'The current concurrent connections quota has been reached.',
                            },
                        });

                        ws.end(4100);
                    } else {
                        this.server.adapter.addSocket(user.app.id, ws);

                        let broadcastMessage = {
                            event: 'pusher:connection_established',
                            data: JSON.stringify({
                                socket_id: user.id,
                                activity_timeout: 30,
                            }),
                        };

                        user.sendJson(broadcastMessage);

                        if (user.app.enableUserAuthentication) {
                            this.setUserAuthenticationTimeout(ws);
                        }

                        this.server.metricsManager.markNewConnection(ws);
                    }
                });
            });
        });
    }

    /**
     * Handle a received message from the client.
     */
    onMessage(ws: WebSocket<WebSocketUserData>, message: uWebSocketMessage, isBinary: boolean): any {
        const user = ws.getUserData();
        if (message instanceof ArrayBuffer) {
            try {
                message = JSON.parse(Utils.ArrayBufferToString(message)) as PusherMessage;
            } catch (err) {
                return;
            }
        }

        if (this.server.options.debug) {
            Log.websocketTitle('⚡ New message received:');
            Log.websocket({ message, isBinary });
        }

        if (message) {
            if (message.event === 'pusher:ping') {
                this.handlePong(ws);
            } else if (message.event === 'pusher:subscribe') {
                this.subscribeToChannel(ws, message);
            } else if (message.event === 'pusher:unsubscribe') {
                this.unsubscribeFromChannel(ws, message.data.channel);
            } else if (Utils.isClientEvent(message.event)) {
                this.handleClientEvent(ws, message);
            } else if (message.event === 'pusher:signin') {
                this.handleSignin(ws, message);
            } else {
                Log.warning({
                    info: 'Message event handler not implemented.',
                    message,
                });
            }
        }

        if (user.app) {
            this.server.metricsManager.markWsMessageReceived(user.app.id, message);
        }
    }

    /**
     * Handle the event of the client closing the connection.
     */
    onClose(ws: WebSocket<WebSocketUserData>, code: number, message: uWebSocketMessage): any {
        if (this.server.options.debug) {
            Log.websocketTitle('❌ Connection closed:');
            Log.websocket({ ws, code, message });
        }

        // If code 4200 (reconnect immediately) is called, it means the `closeAllLocalSockets()` was called.
        if (code !== 4200) {
            this.evictSocketFromMemory(ws);
        }
    }

    /**
     * Evict the local socket.
     */
    evictSocketFromMemory(ws: WebSocket<WebSocketUserData>): Promise<void> {
        return this.unsubscribeFromAllChannels(ws, true).then(() => {
            const user = ws.getUserData();
            if (user.app) {
                this.server.adapter.removeSocket(user.app.id, user.id);
                this.server.metricsManager.markDisconnection(ws);
            }

            this.clearTimeout(ws);
        });
    }

    /**
     * Handle the event to close all existing sockets.
     */
    async closeAllLocalSockets(): Promise<void> {
        let namespaces = this.server.adapter.getNamespaces();

        if (namespaces.size === 0) {
            return Promise.resolve();
        }

        return async.each([...namespaces], ([namespaceId, namespace]: [string, Namespace], nsCallback) => {
            namespace.getSockets().then(sockets => {
                async.each([...sockets], ([wsId, ws]: [string, WebSocket<WebSocketUserData>], wsCallback) => {
                    const user = ws.getUserData();
                    try {
                        user.sendJson({
                            event: 'pusher:error',
                            data: {
                                code: 4200,
                                message: 'Server closed. Please reconnect shortly.',
                            },
                        });

                        ws.end(4200);
                    } catch (e) {
                        //
                    }

                    this.evictSocketFromMemory(ws).then(() => {
                        wsCallback();
                    });
                }).then(() => {
                    this.server.adapter.clearNamespace(namespaceId).then(() => {
                        nsCallback();
                    });
                });
            });
        }).then(() => {
            // One last clear to make sure everything went away.
            return this.server.adapter.clearNamespaces();
        });
    }

    /**
     * Mutate the upgrade request.
     */
    handleUpgrade(res: HttpResponse, req: HttpRequest, context): any {
        res.upgrade(
            {
                ip: Utils.ArrayBufferToString(res.getRemoteAddressAsText()),
                ip2: Utils.ArrayBufferToString(res.getProxiedRemoteAddressAsText()),
                appKey: req.getParameter(0),
            },
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context,
        );
    }

    /**
     * Send back the pong response.
     */
    handlePong(ws: WebSocket<WebSocketUserData>): any {
        const user = ws.getUserData();

        user.sendJson({
            event: 'pusher:pong',
            data: {},
        });

        if (this.server.closing) {
            user.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server closed. Please reconnect shortly.',
                },
            });

            ws.end(4200);

            this.evictSocketFromMemory(ws);
        }
    }

    /**
     * Instruct the server to subscribe the connection to the channel.
     */
    subscribeToChannel(ws: WebSocket<WebSocketUserData>, message: PusherMessage): any {
        const user = ws.getUserData();
        if (this.server.closing) {
            user.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server closed. Please reconnect shortly.',
                },
            });

            ws.end(4200);

            this.evictSocketFromMemory(ws);

            return;
        }

        let channel = message.data.channel;
        let channelManager = this.getChannelManagerFor(channel);

        if (channel.length > user.app.maxChannelNameLength) {
            let broadcastMessage = {
                event: 'pusher:subscription_error',
                channel,
                data: {
                    type: 'LimitReached',
                    error: `The channel name is longer than the allowed ${user.app.maxChannelNameLength} characters.`,
                    status: 4009,
                },
            };

            user.sendJson(broadcastMessage);

            return;
        }

        channelManager.join(ws, channel, message).then((response) => {
            if (!response.success) {
                let { authError, type, errorMessage, errorCode } = response;

                // For auth errors, send pusher:subscription_error
                if (authError) {
                    return user.sendJson({
                        event: 'pusher:subscription_error',
                        channel,
                        data: {
                            type: 'AuthError',
                            error: errorMessage,
                            status: 401,
                        },
                    });
                }

                // Otherwise, catch any non-auth related errors.
                return user.sendJson({
                    event: 'pusher:subscription_error',
                    channel,
                    data: {
                        type: type,
                        error: errorMessage,
                        status: errorCode,
                    },
                });
            }

            if (!user.subscribedChannels.has(channel)) {
                user.subscribedChannels.add(channel);
            }

            // Make sure to update the socket after new data was pushed in.
            this.server.adapter.addSocket(user.app.id, ws);

            // If the connection freshly joined, send the webhook:
            if (response.channelConnections === 1) {
                this.server.webhookSender.sendChannelOccupied(user.app, channel);
            }

            // For non-presence channels, end with subscription succeeded.
            if (!(channelManager instanceof PresenceChannelManager)) {
                let broadcastMessage = {
                    event: 'pusher_internal:subscription_succeeded',
                    channel,
                };

                user.sendJson(broadcastMessage);

                if (Utils.isCachingChannel(channel)) {
                    this.sendMissedCacheIfExists(ws, channel);
                }

                return;
            }

            // Otherwise, prepare a response for the presence channel.
            this.server.adapter.getChannelMembers(user.app.id, channel, false).then(members => {
                let { user_id, user_info } = response.member;

                user.presence.set(channel, response.member);

                // Make sure to update the socket after new data was pushed in.
                this.server.adapter.addSocket(user.app.id, ws);

                // If the member already exists in the channel, don't resend the member_added event.
                if (!members.has(user_id as string)) {
                    this.server.webhookSender.sendMemberAdded(user.app, channel, user_id as string);

                    this.server.adapter.send(user.app.id, channel, JSON.stringify({
                        event: 'pusher_internal:member_added',
                        channel,
                        data: JSON.stringify({
                            user_id: user_id,
                            user_info: user_info,
                        }),
                    }), user.id);

                    members.set(user_id as string, user_info);
                }

                let broadcastMessage = {
                    event: 'pusher_internal:subscription_succeeded',
                    channel,
                    data: JSON.stringify({
                        presence: {
                            ids: Array.from(members.keys()),
                            hash: Object.fromEntries(members),
                            count: members.size,
                        },
                    }),
                };

                user.sendJson(broadcastMessage);

                if (Utils.isCachingChannel(channel)) {
                    this.sendMissedCacheIfExists(ws, channel);
                }
            }).catch(err => {
                Log.error(err);

                user.sendJson({
                    event: 'pusher:error',
                    channel,
                    data: {
                        type: 'ServerError',
                        error: 'A server error has occured.',
                        code: 4302,
                    },
                });
            });
        });
    }

    /**
     * Instruct the server to unsubscribe the connection from the channel.
     */
    unsubscribeFromChannel(ws: WebSocket<WebSocketUserData>, channel: string, closing = false): Promise<void> {
        let channelManager = this.getChannelManagerFor(channel);
        const user = ws.getUserData();

        return channelManager.leave(ws, channel).then(response => {
            let member = user.presence.get(channel);

            if (response.left) {
                // Send presence channel-speific events and delete specific data.
                // This can happen only if the user is connected to the presence channel.
                if (channelManager instanceof PresenceChannelManager && user.presence.has(channel)) {
                    user.presence.delete(channel);

                    // Make sure to update the socket after new data was pushed in.
                    this.server.adapter.addSocket(user.app.id, ws);

                    this.server.adapter.getChannelMembers(user.app.id, channel, false).then(members => {
                        if (!members.has(member.user_id as string)) {
                            this.server.webhookSender.sendMemberRemoved(user.app, channel, member.user_id);

                            this.server.adapter.send(user.app.id, channel, JSON.stringify({
                                event: 'pusher_internal:member_removed',
                                channel,
                                data: JSON.stringify({
                                    user_id: member.user_id,
                                }),
                            }), user.id);
                        }
                    });
                }

                user.subscribedChannels.delete(channel);

                // Make sure to update the socket after new data was pushed in,
                // but only if the user is not closing the connection.
                if (!closing) {
                    this.server.adapter.addSocket(user.app.id, ws);
                }

                if (response.remainingConnections === 0) {
                    this.server.webhookSender.sendChannelVacated(user.app, channel);
                }
            }

            // ws.send(JSON.stringify({
            //     event: 'pusher_internal:unsubscribed',
            //     channel,
            // }));

            return;
        });
    }

    /**
     * Unsubscribe the connection from all channels.
     */
    unsubscribeFromAllChannels(ws: WebSocket<WebSocketUserData>, closing = true): Promise<void> {
        const user = ws.getUserData();
        if (!user.subscribedChannels) {
            return Promise.resolve();
        }

        return Promise.all([
            async.each(user.subscribedChannels, (channel, callback) => {
                this.unsubscribeFromChannel(ws, channel, closing).then(() => callback());
            }),
            user.app && user.user ? this.server.adapter.removeUser(ws) : new Promise<void>(resolve => resolve()),
        ]).then(() => {
            return;
        })
    }

    /**
     * Handle the events coming from the client.
     */
    handleClientEvent(ws: WebSocket<WebSocketUserData>, message: PusherMessage): any {
        let { event, data, channel } = message;
        const user = ws.getUserData();

        if (!user.app.enableClientMessages) {
            return user.sendJson({
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `The app does not have client messaging enabled.`,
                },
            });
        }

        // Make sure the event name length is not too big.
        if (event.length > user.app.maxEventNameLength) {
            let broadcastMessage = {
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `Event name is too long. Maximum allowed size is ${user.app.maxEventNameLength}.`,
                },
            };

            user.sendJson(broadcastMessage);

            return;
        }

        let payloadSizeInKb = Utils.dataToKilobytes(message.data);

        // Make sure the total payload of the message body is not too big.
        if (payloadSizeInKb > parseFloat(user.app.maxEventPayloadInKb as string)) {
            let broadcastMessage = {
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `The event data should be less than ${user.app.maxEventPayloadInKb} KB.`,
                },
            };

            user.sendJson(broadcastMessage);

            return;
        }

        this.server.adapter.isInChannel(user.app.id, channel, user.id).then(canBroadcast => {
            if (!canBroadcast) {
                return;
            }

            this.server.rateLimiter.consumeFrontendEventPoints(1, user.app, ws).then(response => {
                if (response.canContinue) {
                    let userId = user.presence.has(channel) ? user.presence.get(channel).user_id : null;

                    let message = JSON.stringify({
                        event,
                        channel,
                        data,
                        ...userId ? { user_id: userId } : {},
                    });

                    this.server.adapter.send(user.app.id, channel, message, user.id);

                    this.server.webhookSender.sendClientEvent(
                        user.app, channel, event, data, user.id, userId,
                    );

                    return;
                }

                user.sendJson({
                    event: 'pusher:error',
                    channel,
                    data: {
                        code: 4301,
                        message: 'The rate limit for sending client events exceeded the quota.',
                    },
                });
            });
        });
    }

    /**
     * Handle the signin coming from the frontend.
     */
    handleSignin(ws: WebSocket<WebSocketUserData>, message: PusherMessage): void {
        const user = ws.getUserData();
        if (!user.userAuthenticationTimeout) {
            return;
        }

        this.signinTokenIsValid(ws, message.data.user_data, message.data.auth).then(isValid => {
            if (!isValid) {
                user.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4009,
                        message: 'Connection not authorized.',
                    },
                });

                try {
                    ws.end(4009);
                } catch (e) {
                    //
                }

                return;
            }

            let decodedUser = JSON.parse(message.data.user_data);

            if (!decodedUser.id) {
                user.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4009,
                        message: 'The returned user data must contain the "id" field.',
                    },
                });

                try {
                    ws.end(4009);
                } catch (e) {
                    //
                }

                return;
            }

            user.user = {
                ...decodedUser,
                ...{
                    id: decodedUser.id.toString(),
                },
            };

            if (user.userAuthenticationTimeout) {
                clearTimeout(user.userAuthenticationTimeout);
            }

            this.server.adapter.addSocket(user.app.id, ws);

            this.server.adapter.addUser(ws).then(() => {
                user.sendJson({
                    event: 'pusher:signin_success',
                    data: message.data,
                });
            });
        });
    }

    /**
     * Send the first event as cache_missed, if it exists, to catch up.
     */
    sendMissedCacheIfExists(ws: WebSocket<WebSocketUserData>, channel: string) {
        const user = ws.getUserData();
        this.server.cacheManager.get(`app:${user.app.id}:channel:${channel}:cache_miss`).then(cachedEvent => {
            if (cachedEvent) {
                let { event, data } = JSON.parse(cachedEvent);
                user.sendJson({ event: event, channel, data: data });
            } else {
                user.sendJson({ event: 'pusher:cache_miss', channel });
                this.server.webhookSender.sendCacheMissed(user.app, channel);
            }
        });
    }

    /**
     * Get the channel manager for the given channel name,
     * respecting the Pusher protocol.
     */
    getChannelManagerFor(channel: string): PublicChannelManager|PrivateChannelManager|EncryptedPrivateChannelManager|PresenceChannelManager {
        if (Utils.isPresenceChannel(channel)) {
            return this.presenceChannelManager;
        } else if (Utils.isEncryptedPrivateChannel(channel)) {
            return this.encryptedPrivateChannelManager;
        } else if (Utils.isPrivateChannel(channel)) {
            return this.privateChannelManager;
        } else {
            return this.publicChannelManager;
        }
    }

    /**
     * Use the app manager to retrieve a valid app.
     */
    protected checkForValidApp(ws: WebSocket<WebSocketUserData>): Promise<App|null> {
        const user = ws.getUserData();
        return this.server.appManager.findByKey(user.appKey);
    }

    /**
     * Make sure that the app is enabled.
     */
    protected checkIfAppIsEnabled(ws: WebSocket<WebSocketUserData>): Promise<boolean> {
        const user = ws.getUserData();
        return Promise.resolve(user.app.enabled);
    }

    /**
     * Make sure the connection limit is not reached with this connection.
     * Return a boolean wether the user can connect or not.
     */
    protected checkAppConnectionLimit(ws: WebSocket<WebSocketUserData>): Promise<boolean> {
        const user = ws.getUserData();
        return this.server.adapter.getSocketsCount(user.app.id).then(wsCount => {
            let maxConnections = parseInt(user.app.maxConnections as string) || -1;

            if (maxConnections < 0) {
                return true;
            }

            return wsCount + 1 <= maxConnections;
        }).catch(err => {
            Log.error(err);
            return false;
        });
    }

    /**
     * Check is an incoming connection can subscribe.
     */
    signinTokenIsValid(ws: WebSocket<WebSocketUserData>, user: string, signatureToCheck: string): Promise<boolean> {
        return this.signinTokenForuser(ws, user).then(expectedSignature => {
            return signatureToCheck === expectedSignature;
        });
    }

    /**
     * Get the signin token from the given message, by the Socket.
     */
    protected signinTokenForuser(ws: WebSocket<WebSocketUserData>, user: string): Promise<string> {
        return new Promise(resolve => {
            const userData = ws.getUserData();
            const decodedString = `${userData.id}::user::${user}`;
            const hmac = createHmac('sha256', userData.app.secret).update(decodedString).digest('hex');

            resolve(`${userData.app.key}:${hmac}`);
        });
    }

    /**
     * Generate a Pusher-like Socket ID.
     */
    protected generateSocketId(): string {
        let min = 0;
        let max = 10000000000;

        let randomNumber = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

        return randomNumber(min, max) + '.' + randomNumber(min, max);
    }

    /**
     * Clear WebSocket timeout.
     */
    protected clearTimeout(ws: WebSocket<WebSocketUserData>): void {
        const user = ws.getUserData();
        if (user.timeout) {
            clearTimeout(user.timeout);
        }
    }

    /**
     * Update WebSocket timeout.
     */
    protected updateTimeout(ws: WebSocket<WebSocketUserData>): void {
        this.clearTimeout(ws);
        const user = ws.getUserData();

        user.timeout = setTimeout(() => {
            try {
                ws.end(4201);
            } catch (e) {
                //
            }
        }, 120_000);
    }

    /**
     * Set the authentication timeout for the socket.
     */
    protected setUserAuthenticationTimeout(ws: WebSocket<WebSocketUserData>): void {
        const user = ws.getUserData();
        user.userAuthenticationTimeout = setTimeout(() => {
            user.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4009,
                    message: 'Connection not authorized within timeout.',
                },
            });

            try {
                ws.end(4009);
            } catch (e) {
                //
            }
        }, this.server.options.userAuthenticationTimeout);
    }
}
