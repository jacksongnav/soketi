import { PresenceMember } from '../channels/presence-channel-manager.js';
import { PusherMessage } from '../message.js';
import { Server } from '../server.js';
import { WebSocketUserData } from '../types.js';
import { Utils } from '../utils.js';
import { WebSocket } from 'uWebSockets.js';

export interface JoinResponse {
    ws: WebSocket<WebSocketUserData>;
    success: boolean;
    channelConnections?: number;
    authError?: boolean;
    member?: PresenceMember;
    errorMessage?: string;
    errorCode?: number;
    type?: string;
}

export interface LeaveResponse {
    left: boolean;
    remainingConnections?: number;
    member?: PresenceMember;
}

export class PublicChannelManager {
    constructor(protected server: Server) {
        //
    }

    /**
     * Join the connection to the channel.
     */
    join(ws: WebSocket<WebSocketUserData>, channel: string, message?: PusherMessage): Promise<JoinResponse> {
        const user = ws.getUserData();
        if (Utils.restrictedChannelName(channel)) {
            return Promise.resolve({
                ws,
                success: false,
                errorCode: 4009,
                errorMessage: 'The channel name is not allowed. Read channel conventions: https://pusher.com/docs/channels/using_channels/channels/#channel-naming-conventions',
            });
        }

        if (!user.app) {
            return Promise.resolve({
                ws,
                success: false,
                errorCode: 4009,
                errorMessage: 'Subscriptions messages should be sent after the pusher:connection_established event is received.',
            });
        }

        return this.server.adapter.addToChannel(user.app.id, channel, ws).then(connections => {
            return {
                ws,
                success: true,
                channelConnections: connections,
            };
        });
    }

    /**
     * Mark the connection as closed and unsubscribe it.
     */
    leave(ws: WebSocket<WebSocketUserData>, channel: string): Promise<LeaveResponse> {
        const user = ws.getUserData();
        return this.server.adapter.removeFromChannel(user.app.id, channel, user.id).then((remainingConnections) => {
            return {
                left: true,
                remainingConnections: remainingConnections as number,
            };
        });
    }
}
