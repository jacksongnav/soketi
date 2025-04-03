import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { Options } from './options';
import { networkInterfaces } from 'os';

export interface NodeInfo {
  id: string;
  address: string;
  port: number;
  isMaster: boolean;
  lastSeen: number;
}

export class CustomDiscovery extends EventEmitter {
  private socket: dgram.Socket;
  private nodes: Map<string, NodeInfo> = new Map();
  public me: NodeInfo;
  private options: any;
  private masterId: string | null = null;
  private interval: NodeJS.Timeout;

  constructor(options: Options["cluster"]) {
    super();
    this.options = options;
    this.me = {
      id: `${this.options.prefix}-${Date.now()}`,
      address: this.getIpAddress(),
      isMaster: true,
      port: this.options.port,
      lastSeen: Date.now(),
    };
    this.nodes.set(this.me.id, this.me);
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', this.handleMessage.bind(this));
    this.socket.on('error', (err) => {
      console.error('UDP socket error:', err);
    });
  }

  private getIpAddress(): string {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if ('IPv4' !== iface.family || iface.internal !== false) {
                continue;
            }
            return iface.address;
        }
    }
    return '127.0.0.1';
  }

  public start(): void {
    this.socket.bind(this.options.port, () => {
      this.socket.setBroadcast(true);
      this.sendHello();
      this.interval = setInterval(() => this.sendHello(), this.options.helloInterval);
      this.checkTimeouts();
    });
  }

  private sendHello(): void {
    const message = Buffer.from(JSON.stringify({
      id: this.me.id,
      address: this.me.address,
      port: this.me.port,
    }));
    this.socket.send(message, this.options.port, this.options.broadcast);
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const nodeInfo = JSON.parse(msg.toString());
      if (nodeInfo.id === this.me.id) return; // Ignore self

      const newNode: NodeInfo = {
        id: nodeInfo.id,
        address: rinfo.address,
        isMaster: nodeInfo.isMaster,
        port: nodeInfo.port,
        lastSeen: Date.now(),
      };

      if (!this.nodes.has(nodeInfo.id)) {
        this.nodes.set(nodeInfo.id, newNode);
        this.emit('added', newNode);
      } else {
        this.nodes.set(nodeInfo.id, newNode); // Update last seen
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  }

  private checkTimeouts(): void {
    setInterval(() => {
      const now = Date.now();
      this.nodes.forEach((node, id) => {
        if (node.id === this.me.id) return; // Ignore self

        if (now - node.lastSeen > this.options.nodeTimeout) {
          this.nodes.delete(id);
          this.emit('removed', node);
        }
      });
      this.electMaster();
    }, this.options.checkInterval);
  }

  private electMaster(): void {
    const sortedNodes = Array.from(this.nodes.values()).sort((a, b) => a.id.localeCompare(b.id));
    const newMasterId = sortedNodes[0].id;

    if (this.masterId !== newMasterId) {
      this.masterId = newMasterId;
      const masterNode = this.nodes.get(newMasterId);
      if(masterNode){
          this.emit('master', masterNode);
      }
    }
  }
}