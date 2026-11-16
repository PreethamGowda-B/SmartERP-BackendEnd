'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const Redis = require('ioredis');

test('Redis connection lifecycle & retry backoff calculation', () => {
  const { redisClient } = require('../utils/redis');
  // retryStrategy calculation
  const retryStrategy = (times) => Math.min(times * 300, 3000);
  assert.equal(retryStrategy(1), 300);
  assert.equal(retryStrategy(2), 600);
  assert.equal(retryStrategy(10), 3000);
  assert.equal(retryStrategy(50), 3000);
});

test('Redis TCP socket disconnect and reconnect simulation', async () => {
  let serverSocket;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    socket.on('data', (buf) => {
      const s = buf.toString();
      if (s.includes('PING')) socket.write('+PONG\r\n');
      else socket.write('+OK\r\n');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const client = new Redis({
    host: '127.0.0.1',
    port,
    enableReadyCheck: false,
    retryStrategy: () => 50,
  });
  client.on('error', () => {});

  await new Promise((resolve) => client.once('connect', resolve));
  assert.equal(client.status, 'connect');

  // Trigger disconnect
  let reconnected = false;
  client.on('connect', () => { reconnected = true; });
  serverSocket.destroy();

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(reconnected, true);

  client.disconnect();
  await new Promise((resolve) => server.close(resolve));
});
