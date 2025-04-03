import { Server } from './../src/server';
import { Utils } from './utils';

jest.retryTimes(parseInt(process.env.RETRY_TIMES || '1'));

describe('test test', () => {
    beforeEach(() => {
        jest.resetModules();
    
        return Utils.waitForPortsToFreeUp()
    });

    afterEach(() => {
        return Utils.flushServers();
    });

    Utils.shouldRun(Utils.appManagerIs('array'))('signin after connection', done => {
        Utils.newServer({ 'appManager.array.apps.0.enableUserAuthentication': true, 'userAuthenticationTimeout': 5_000 }, (server: Server) => {
            let client = Utils.newClientForPrivateChannel({}, 6001, 'app-key', { id: 1 });

            client.connection.bind('connected', () => {
                console.log('connected');
                client.connection.bind('message', ({ event, data }) => {
                    console.log('message', event, data);
                    if (event === 'pusher:signin_success') {
                        // After subscription, wait 10 seconds to make sure it isn't disconnected
                        setTimeout(() => {
                            client.disconnect();
                            done();
                        }, 10_000);
                    } else {
                        done(new Error('Unexpected event: ' + event));
                    }
                });

                client.signin();
            });
        });
    });
});
