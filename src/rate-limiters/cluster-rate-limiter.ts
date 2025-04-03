import { App } from './../app';
import { ConsumptionResponse } from './rate-limiter-interface';
import { LocalRateLimiter } from './local-rate-limiter';
import { RateLimiterAbstract, RateLimiterClusterMasterPM2 } from 'rate-limiter-flexible';
import { Server } from '../server';
import { NodeInfo } from '../discovery';

import cluster from 'cluster';
import pm2 from 'pm2';

export interface ConsumptionMessage {
  app: App;
  eventKey: string;
  points: number;
  maxPoints: number;
}

export class ClusterRateLimiter extends LocalRateLimiter {
  /**
   * Initialize the local rate limiter driver.
   */
  constructor(protected server: Server) {
    super(server);

    if (cluster.isPrimary || typeof cluster.isPrimary === 'undefined') {
      if (server.pm2) {
        // With PM2, discovery is not needed.
        new RateLimiterClusterMasterPM2(pm2);
      } else {
        // When a new master is demoted, the rate limiters it has become the pivot points of the real, synced
        // rate limiter instances. Just trust this value.
        server.discover.on('rate_limiter:limiters', (rateLimiters: { [key: string]: RateLimiterAbstract }) => {
          this.rateLimiters = Object.fromEntries(
            Object.entries(rateLimiters).map(([key, rateLimiterObject]: [string, any]) => {
              return [
                key,
                this.createNewRateLimiter(key.split(':')[0], rateLimiterObject._points),
              ];
            })
          );
        });

        // All nodes need to know when other nodes consumed from the rate limiter.
        server.discover.on('rate_limiter:consume', ({ app, eventKey, points, maxPoints }: ConsumptionMessage) => {
          super.consume(app, eventKey, points, maxPoints);
        });

        server.discover.on('added', (node: NodeInfo) => {
          if (server.nodes.get('self').isMaster) {
            // When a new node is added, just send the rate limiters this master instance has.
            // This value is the true value of the rate limiters.
            this.sendRateLimiters();
          }
        });
      }
    }
  }

  /**
   * Consume points for a given key, then
   * return a response object with headers and the success indicator.
   */
  protected consume(app: App, eventKey: string, points: number, maxPoints: number): Promise<ConsumptionResponse> {
    return super.consume(app, eventKey, points, maxPoints).then((response) => {
      if (response.canContinue) {
        this.server.discover.emit('rate_limiter:consume', {
          app, eventKey, points, maxPoints,
        });
      }

      return response;
    });
  }

  /**
   * Clear the rate limiter or active connections.
   */
  disconnect(): Promise<void> {
    return super.disconnect().then(() => {
      // If the current instance is the master and the server is closing,
      // demote and send the rate limiter of the current instance to the new master.
      if (this.server.nodes.get('self').isMaster) {
        // Assuming your CustomDiscovery emits a 'master' event with the new master node.
        const sortedNodes = Array.from(this.server.nodes.values()).sort((a, b) => a.id.localeCompare(b.id));
        const newMasterId = sortedNodes[0].id;
        const newMasterNode = this.server.nodes.get(newMasterId);

        if (newMasterNode) {
            this.server.discover.emit('master', newMasterNode);
            this.server.discover.emit('rate_limiter:limiters', this.rateLimiters);
        }
      }
    });
  }

  /**
   * Send the stored rate limiters this instance currently have.
   */
  protected sendRateLimiters(): void {
    this.server.discover.emit('rate_limiter:limiters', this.rateLimiters);
  }
}