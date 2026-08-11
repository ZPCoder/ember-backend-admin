import assert from 'node:assert/strict';

const endpoint = process.argv[2] ?? 'ws://127.0.0.1:8787';

function inbox(socket) {
  const queue = [];
  const waiters = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  };
  return {
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function open(socket) {
  return new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
}

async function nextType(clientInbox, type) {
  for (;;) {
    const message = await clientInbox.next();
    if (message.type === type) return message;
  }
}

const alice = new WebSocket(endpoint);
const bob = new WebSocket(endpoint);
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

alice.close();
bob.close();
console.log('multiplayer smoke test passed');
