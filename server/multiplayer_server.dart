import 'dart:convert';
import 'dart:io';
import 'dart:math';

class _Peer {
  _Peer(this.socket, this.id);

  final WebSocket socket;
  final String id;
  String name = '旅者';
  String? room;
}

class _Room {
  _Room(this.code);

  final String code;
  final List<_Peer> peers = <_Peer>[];
}

final _rooms = <String, _Room>{};
final _peers = <WebSocket, _Peer>{};
final _random = Random.secure();

void main(List<String> args) async {
  final port = int.tryParse(args.isEmpty ? '' : args.first) ?? 8787;
  final server = await HttpServer.bind(InternetAddress.anyIPv4, port);
  print('ASTRA multiplayer server listening on ws://0.0.0.0:$port');
  await for (final request in server) {
    if (WebSocketTransformer.isUpgradeRequest(request)) {
      final socket = await WebSocketTransformer.upgrade(request);
      _accept(socket);
    } else {
      request.response
        ..statusCode = HttpStatus.notFound
        ..headers.contentType = ContentType.text
        ..write('ASTRA multiplayer server');
      await request.response.close();
    }
  }
}

void _accept(WebSocket socket) {
  final peer = _Peer(socket, 'p-${DateTime.now().microsecondsSinceEpoch}');
  _peers[socket] = peer;
  _send(peer, <String, dynamic>{
    'type': 'welcome',
    'playerId': peer.id,
    'message': '连接成功',
  });
  socket.listen(
    (data) => _handle(peer, data),
    onDone: () => _leave(peer),
    onError: (_) => _leave(peer),
    cancelOnError: true,
  );
}

void _handle(_Peer peer, Object? raw) {
  if (raw is! String) return;
  final decoded = jsonDecode(raw);
  if (decoded is! Map) return;
  final message = Map<String, dynamic>.from(decoded);
  switch (message['type']) {
    case 'hello':
      final name = message['name']?.toString().trim();
      if (name != null && name.isNotEmpty) peer.name = name;
      break;
    case 'create_room':
      _createRoom(peer);
      break;
    case 'join_room':
      _joinRoom(peer, message['room']?.toString().toUpperCase() ?? '');
      break;
    case 'action':
      _relayAction(peer, message);
      break;
    case 'leave_room':
      _leaveRoom(peer);
      break;
  }
}

void _createRoom(_Peer peer) {
  _leaveRoom(peer);
  String code;
  do {
    code = List<String>.generate(
      4,
      (_) => String.fromCharCode(65 + _random.nextInt(26)),
    ).join();
  } while (_rooms.containsKey(code));
  final room = _Room(code)..peers.add(peer);
  _rooms[code] = room;
  peer.room = code;
  _send(peer, <String, dynamic>{
    'type': 'room_created',
    'room': code,
    'message': '房间已创建，等待对手加入',
  });
  _sendState(room);
}

void _joinRoom(_Peer peer, String code) {
  final room = _rooms[code];
  if (room == null) {
    _error(peer, '房间 $code 不存在');
    return;
  }
  if (room.peers.length >= 2) {
    _error(peer, '房间已满');
    return;
  }
  _leaveRoom(peer);
  room.peers.add(peer);
  peer.room = room.code;
  _send(peer, <String, dynamic>{
    'type': 'room_joined',
    'room': room.code,
    'message': '已加入房间',
  });
  for (final other in room.peers.where((item) => item != peer)) {
    _send(other, <String, dynamic>{
      'type': 'peer_joined',
      'peerName': peer.name,
      'playerId': peer.id,
      'message': '${peer.name} 已加入房间',
    });
  }
  _sendState(room);
}

void _relayAction(_Peer peer, Map<String, dynamic> message) {
  final room = peer.room == null ? null : _rooms[peer.room];
  if (room == null) {
    _error(peer, '请先创建或加入房间');
    return;
  }
  for (final other in room.peers.where((item) => item != peer)) {
    _send(other, <String, dynamic>{
      'type': 'action',
      'playerId': peer.id,
      'peerName': peer.name,
      'action': message['action'],
      'payload': message['payload'] is Map ? message['payload'] : {},
    });
  }
  _send(peer, <String, dynamic>{
    'type': 'action_ack',
    'action': message['action'],
  });
}

void _sendState(_Room room) {
  final players = room.peers
      .map((peer) => <String, dynamic>{'id': peer.id, 'name': peer.name})
      .toList(growable: false);
  for (final peer in room.peers) {
    _send(peer, <String, dynamic>{
      'type': 'room_state',
      'room': room.code,
      'payload': <String, dynamic>{'players': players},
    });
  }
}

void _leave(_Peer peer) {
  _peers.remove(peer.socket);
  _leaveRoom(peer);
}

void _leaveRoom(_Peer peer) {
  final code = peer.room;
  if (code == null) return;
  final room = _rooms[code];
  peer.room = null;
  if (room == null) return;
  room.peers.remove(peer);
  for (final other in room.peers) {
    _send(other, <String, dynamic>{
      'type': 'peer_left',
      'peerName': peer.name,
      'message': '${peer.name} 已离开房间',
    });
  }
  if (room.peers.isEmpty) {
    _rooms.remove(code);
  } else {
    _sendState(room);
  }
}

void _error(_Peer peer, String message) {
  _send(peer, <String, dynamic>{'type': 'error', 'message': message});
}

void _send(_Peer peer, Map<String, dynamic> message) {
  try {
    peer.socket.add(jsonEncode(message));
  } catch (_) {
    _leave(peer);
  }
}
