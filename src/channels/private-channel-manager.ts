import { App } from '../app.js';
import { JoinResponse, PublicChannelManager } from './public-channel-manager.js';
import { PusherMessage } from '../message.js';
import { WebSocket } from 'uWebSockets.js';
import { WebSocketUserData } from '../types.js';

import Pusher from 'pusher';
import { createHmac } from 'crypto';

export class PrivateChannelManager extends PublicChannelManager {
    /**
     * Join the connection to the channel.
     */
    join(ws: WebSocket<WebSocketUserData>, channel: string, message?: PusherMessage): Promise<JoinResponse> {
        let passedSignature = message?.data?.auth;
        const user = ws.getUserData();

        return this.signatureIsValid(user.app, user.id, message, passedSignature).then(isValid => {
            if (!isValid) {
                return {
                    ws,
                    success: false,
                    errorCode: 4009,
                    errorMessage: 'The connection is unauthorized.',
                    authError: true,
                    type: 'AuthError',
                };
            }

            return super.join(ws, channel, message).then(joinResponse => {
                // If the users joined to a private channel with authentication,
                // proceed clearing the authentication timeout.
                if (joinResponse.success && user.userAuthenticationTimeout) {
                    clearTimeout(user.userAuthenticationTimeout);
                }

                return joinResponse;
            });
        });
    }

    /**
     * Check is an incoming connection can subscribe.
     */
    protected signatureIsValid(app: App, socketId: string, message: PusherMessage, signatureToCheck: string): Promise<boolean> {
        return this.getExpectedSignature(app, socketId, message).then(expectedSignature => {
            return signatureToCheck === expectedSignature;
        });
    }

    /**
     * Get the signed token from the given message, by the Socket.
     */
    protected getExpectedSignature(app: App, socketId: string, message: PusherMessage): Promise<string> {
        return new Promise(resolve => {
            const dataToSign = this.getDataToSignForSignature(socketId, message);
            const hmac = createHmac('sha256', app.secret).update(dataToSign).digest('hex');
    
            resolve(`${app.key}:${hmac}`);
        });
    }

    /**
     * Get the data to sign for the token for specific channel.
     */
    protected getDataToSignForSignature(socketId: string, message: PusherMessage): string {
        return `${socketId}:${message.data.channel}`;
    }
}
