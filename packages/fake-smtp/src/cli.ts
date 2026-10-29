#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { FakeSmtpServer } from './server.js';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', default: '2525' },
    latency: { type: 'string', default: '0' },
    'catch-all': { type: 'string', default: '' },
    'greylist-times': { type: 'string', default: '1' },
  },
});

const latency = values.latency.includes(',')
  ? (values.latency.split(',').map(Number) as [number, number])
  : Number(values.latency);

const server = new FakeSmtpServer({
  host: values.host,
  port: Number(values.port),
  latencyMs: latency,
  catchAllDomains: values['catch-all'].split(',').filter(Boolean),
  greylistTimes: Number(values['greylist-times']),
});

const port = await server.start();
console.log(`fake-smtp listening on ${values.host}:${port} (latency=${values.latency}ms)`);

const shutdown = () => void server.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
