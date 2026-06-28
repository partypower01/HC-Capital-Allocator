import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { EventEnvelope } from '../types.js';

export class HCEventBus {
  private redis: Redis;
  private streamName: string;
  private groupName: string;

  constructor(options: { redisUrl?: string, streamName?: string, groupName?: string } = {}) {
    this.redis = new Redis(options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
    this.streamName = options.streamName || 'hc-events';
    this.groupName = options.groupName || 'hc-default-group';
  }

  async publish(event: Partial<EventEnvelope> & Pick<EventEnvelope, 'event_type' | 'producer' | 'payload' | 'correlation_id'>): Promise<string> {
    const fullEvent: EventEnvelope = {
      event_id: event.event_id || uuidv4(),
      event_type: event.event_type,
      producer: event.producer,
      timestamp: event.timestamp || new Date().toISOString(),
      schema_version: event.schema_version || '1.0.0',
      correlation_id: event.correlation_id,
      payload: event.payload,
      signature: event.signature,
    };

    const id = await this.redis.xadd(
      this.streamName,
      '*',
      'event',
      JSON.stringify(fullEvent)
    );

    return id!;
  }

  async subscribe(consumerName: string, callback: (event: EventEnvelope) => Promise<void>, eventTypes: string[] = ['*']) {
    // Ensure group exists
    try {
      await this.redis.xgroup('CREATE', this.streamName, this.groupName, '0', 'MKSTREAM');
    } catch (e: any) {
      if (!e.message.includes('BUSYGROUP')) {
        throw e;
      }
    }

    console.log(`Consumer ${consumerName} subscribed to types: ${eventTypes.join(', ')}`);

    // Polling loop (simplified for client lib)
    const poll = async () => {
      try {
        const results: any = await this.redis.xreadgroup(
          'GROUP', this.groupName, consumerName,
          'COUNT', 1,
          'BLOCK', 1000,
          'STREAMS', this.streamName, '>'
        );

        if (results) {
          for (const [_, messages] of results) {
            for (const [id, [__, eventJson]] of messages) {
              const event: EventEnvelope = JSON.parse(eventJson);
              if (eventTypes.includes('*') || eventTypes.includes(event.event_type)) {
                try {
                  await callback(event);
                } catch (err) {
                  console.error(`Error processing event ${id}:`, err);
                }
              }
              // Always acknowledge to move the pointer
              await this.redis.xack(this.streamName, this.groupName, id);
            }
          }
        }
      } catch (err) {
        console.error('Subscription error:', err);
      }
      setImmediate(poll);
    };

    poll();
  }

  async disconnect() {
    await this.redis.quit();
  }
}
