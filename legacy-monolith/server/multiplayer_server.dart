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
const _maxMessageBytes = 64 * 1024;

void main(List<String> args) async {
  if (args.isNotEmpty && args.first == '--health-check') {
    final port = int.tryParse(args.length > 1 ? args[1] : '') ?? 8787;
    await _runHealthCheck(port);
    return;
  }

  final port = int.tryParse(args.isEmpty ? '' : args.first) ?? 8787;
  final server = await HttpServer.bind(InternetAddress.anyIPv4, port);
  print('ASTRA multiplayer server listening on ws://0.0.0.0:$port');
  await for (final request in server) {
    if (request.method == 'GET' && request.uri.path == '/healthz') {
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType.text
        ..headers.set(HttpHeaders.cacheControlHeader, 'no-store')
        ..write('ok\n');
      await request.response.close();
    } else if (WebSocketTransformer.isUpgradeRequest(request)) {
      final socket = await WebSocketTransformer.upgrade(request);
      _accept(socket);
    } else {
      request.response
        ..statusCode = HttpStatus.notFound
        ..headers.contentType = ContentType.text
        ..write('Not found\n');
      await request.response.close();
    }
  }
}

Future<void> _runHealthCheck(int port) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
  try {
    final request = await client.getUrl(
      Uri.parse('http://127.0.0.1:$port/healthz'),
    );
    final response = await request.close().timeout(const Duration(seconds: 2));
    await response.drain<void>();
    if (response.statusCode != HttpStatus.ok) {
      throw HttpException('health endpoint returned ${response.statusCode}');
    }
  } catch (error) {
    stderr.writeln('ASTRA multiplayer health check failed: $error');
    exitCode = 1;
  } finally {
    client.close(force: true);
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
  if (raw is! String) {
    _reject(peer, WebSocketStatus.unsupportedData, '仅支持文本消息');
    return;
  }
  if (raw.length > _maxMessageBytes ||
      utf8.encode(raw).length > _maxMessageBytes) {
    _reject(peer, WebSocketStatus.messageTooBig, '消息不能超过 64 KiB');
    return;
  }

  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } on FormatException {
    _error(peer, '消息必须是有效的 JSON 对象');
    return;
  }
  if (decoded is! Map) {
    _error(peer, '消息必须是 JSON 对象');
    return;
  }
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
    default:
      _error(peer, '未知的消息类型');
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
  if (!RegExp(r'^[A-Z]{4}$').hasMatch(code)) {
    _error(peer, '房间码必须是 4 位英文字母');
    return;
  }
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

void _reject(_Peer peer, int statusCode, String reason) {
  peer.socket.close(statusCode, reason);
  _leave(peer);
}

void _send(_Peer peer, Map<String, dynamic> message) {
  try {
    peer.socket.add(jsonEncode(message));
  } catch (_) {
    _leave(peer);
  }
}
