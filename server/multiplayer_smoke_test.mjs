import assert from 'node:assert/strict';

const endpoint = process.argv[2] ?? 'ws://127.0.0.1:8080/ws';
const sockets = [];

function trackedSocket(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  return socket;
}

function inbox(socket) {
  const queue = [];
  const waiters = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  };
  return {
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for a WebSocket message'));
        }, 5000);
        waiters.push(waiter);
      });
    },
  };
}

function open(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out opening a WebSocket')),
      5000,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });
}

function closed(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for WebSocket close')),
      5000,
    );
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

async function nextType(clientInbox, type) {
  for (;;) {
    const message = await clientInbox.next();
    if (message.type === type) return message;
  }
}

async function assertHealth() {
  const healthUrl = new URL(endpoint);
  healthUrl.protocol = healthUrl.protocol === 'wss:' ? 'https:' : 'http:';
  healthUrl.pathname = '/healthz';
  healthUrl.search = '';
  healthUrl.hash = '';
  const response = await fetch(healthUrl);
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), 'ok');
}

try {
  await assertHealth();

  const alice = trackedSocket(endpoint);
  const bob = trackedSocket(endpoint);
  const aliceInbox = inbox(alice);
  const bobInbox = inbox(bob);
  await Promise.all([open(alice), open(bob)]);

  await nextType(aliceInbox, 'welcome');
  await nextType(bobInbox, 'welcome');
  alice.send(JSON.stringify({ type: 'hello', name: '曙光指挥官' }));
  bob.send(JSON.stringify({ type: 'hello', name: '幽潮旅者' }));
  alice.send(JSON.stringify({ type: 'create_room' }));
  const created = await nextType(aliceInbox, 'room_created');
  assert.equal(created.type, 'room_created');
  assert.match(created.room, /^[A-Z]{4}$/);

  bob.send(JSON.stringify({ type: 'join_room', room: created.room }));
  await nextType(bobInbox, 'room_joined');
  await nextType(aliceInbox, 'peer_joined');

  alice.send(
    JSON.stringify({
      type: 'action',
      action: 'ready',
      payload: { turn: 1 },
    }),
  );
  const relayed = await nextType(bobInbox, 'action');
  assert.equal(relayed.type, 'action');
  assert.equal(relayed.action, 'ready');
  assert.equal(relayed.payload.turn, 1);

  alice.send(
    JSON.stringify({
      type: 'action',
      action: 'play_card',
      payload: { cardId: 'yglight-unit-01', attack: 4, health: 5 },
    }),
  );
  const played = await nextType(bobInbox, 'action');
  assert.equal(played.action, 'play_card');
  assert.equal(played.payload.cardId, 'yglight-unit-01');

  bob.send(
    JSON.stringify({
      type: 'action',
      action: 'attack',
      payload: { cardId: 'yglight-unit-01', damage: 4 },
    }),
  );
  const attacked = await nextType(aliceInbox, 'action');
  assert.equal(attacked.action, 'attack');
  assert.equal(attacked.payload.damage, 4);

  const malformed = trackedSocket(endpoint);
  const malformedInbox = inbox(malformed);
  await open(malformed);
  await nextType(malformedInbox, 'welcome');
  malformed.send('{');
  const parseError = await nextType(malformedInbox, 'error');
  assert.match(parseError.message, /JSON/);
  malformed.send(JSON.stringify({ type: 'create_room' }));
  await nextType(malformedInbox, 'room_created');
  malformed.close();

  const oversized = trackedSocket(endpoint);
  const oversizedInbox = inbox(oversized);
  await open(oversized);
  await nextType(oversizedInbox, 'welcome');
  const oversizedClosed = closed(oversized);
  oversized.send('x'.repeat(64 * 1024 + 1));
  const closeEvent = await oversizedClosed;
  assert.equal(closeEvent.code, 1009);

  const peerLeft = nextType(bobInbox, 'peer_left');
  alice.close();
  await peerLeft;
  bob.close();

  console.log('multiplayer smoke test passed');
} finally {
  for (const socket of sockets) {
    if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      socket.close();
    }
  }
}
