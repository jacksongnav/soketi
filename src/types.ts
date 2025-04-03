import { PresenceMember, PresenceMemberInfo } from "./channels";

export interface WebSocketUserData {
    app?: any;
    user?: any
    id?: string;
    subscribedChannels?: Set<string>;
    presence?: Map<string, PresenceMemberInfo>
    sendJson?: (data: any) => void; // Add sendJson as a function
    setUserData?: (data: any) => void;
    userAuthenticationTimeout?: NodeJS.Timeout;
    appKey?: string
    timeout: any
    ip?: any
    ip2?: any
}

export interface ServerOptions {
    'cluster.prefix'?: string;
    'adapter.redis.prefix'?: string;
    'adapter.nats.prefix'?: string;
    'appManager.array.apps.0.maxBackendEventsPerSecond'?: number;
    'appManager.array.apps.0.maxClientEventsPerSecond'?: number;
    'appManager.array.apps.0.maxReadRequestsPerSecond'?: number;
    'metrics.enabled'?: boolean;
    'appManager.mysql.useMysql2'?: boolean;
    'cluster.port'?: number;
    'appManager.dynamodb.endpoint'?: string;
    'cluster.ignoreProcess'?: boolean;
    'webhooks.batching.enabled'?: boolean;
    'webhooks.batching.duration'?: number;
    'appManager.cache.enabled'?: boolean;
    'appManager.cache.ttl'?: number;
    'adapter.driver'?: string;
    'cache.driver'?: string;
    'appManager.driver'?: string;
    'queue.driver'?: string;
    'rateLimiter.driver'?: string;
    'database.mysql.user'?: string;
    'database.mysql.password'?: string;
    'database.mysql.database'?: string;
    'database.postgres.user'?: string;
    'database.postgres.password'?: string;
    'database.postgres.database'?: string;
    'queue.sqs.queueUrl'?: string;
    'debug'?: boolean | string;
    'shutdownGracePeriod'?: number;
    [key: string]: any; // Allow additional properties
}