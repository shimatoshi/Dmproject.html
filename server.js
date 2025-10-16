// server.js  (Node 24 / ESM: package.json に "type": "module" を指定)
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

// ====== 設定 ======
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const ROLE_LEASE_MS = parseInt(process.env.ROLE_LEASE_MS || "90000", 10); // 切断後の優先権猶予 (ms)

// ====== パス解決 ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== HTTP (静的配信) ======
const app = express();
app.use(express.static(__dirname));     // 同ディレクトリから index.html を配信
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

const server = createServer(app);

// ====== ルーム状態 ======
const rooms = {}; 
// roomId -> {
//   slots:[ws|null, ws|null], spectators:Set<ws>,
//   specQueue: string[],                 // deviceId 先着
//   playerToken:[string|null, string|null],
//   playerLeaseExpiry:[number, number],   // ms epoch
//   playerLeaseTimer:[NodeJS.Timeout|null, NodeJS.Timeout|null],
//   state:any, lastUpdated:number, cleanupTimer:NodeJS.Timeout|null
// }

function now(){ return Date.now(); }

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      slots: [null, null],
      spectators: new Set(),
      specQueue: [],
      playerToken: [null, null],
      playerLeaseExpiry: [0, 0],
      playerLeaseTimer: [null, null],
      state: null,
      lastUpdated: now(),
      cleanupTimer: null,
    };
  }
  return rooms[roomId];
}

function send(ws, obj){
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

function broadcast(roomId, obj){
  const room = rooms[roomId]; if (!room) return;
  const payload = JSON.stringify(obj);
  const targets = [room.slots[0], room.slots[1], ...room.spectators].filter(Boolean);
  for (const peer of targets) {
    if (peer.readyState === peer.OPEN) {
      try { peer.send(payload); } catch {}
    }
  }
}

function assignRole(room, roleIdx, ws){
  room.slots[roleIdx] = ws;
  ws.roleIdx = roleIdx;
  room.playerToken[roleIdx] = ws.deviceId || null;
  room.playerLeaseExpiry[roleIdx] = 0;
  if (room.playerLeaseTimer[roleIdx]) {
    clearTimeout(room.playerLeaseTimer[roleIdx]);
    room.playerLeaseTimer[roleIdx] = null;
  }
}

function enqueueSpectator(room, ws){
  room.spectators.add(ws);
  if (ws.deviceId && !room.specQueue.includes(ws.deviceId)) {
    room.specQueue.push(ws.deviceId);
  }
}

function dequeueNextLiveSpectator(room){
  while (room.specQueue.length) {
    const dev = room.specQueue.shift();
    for (const s of room.spectators) {
      if (s.readyState === s.OPEN && s.deviceId === dev) {
        room.spectators.delete(s);
        return s;
      }
    }
    // 見つからなければ次へ
  }
  return null;
}

function onLeaseExpire(roomId, roleIdx){
  const room = rooms[roomId]; if (!room) return;
  if (!room.slots[roleIdx]) {
    const s = dequeueNextLiveSpectator(room);
    if (s) {
      assignRole(room, roleIdx, s);
      send(s, { type: "role", index: roleIdx });
      if (room.state) send(s, { type: "syncState", state: room.state });
      console.log(`[WS] promote spectator -> role=${roleIdx}`);
      return;
    }
    // 観戦がいなければ優先権破棄
    room.playerToken[roleIdx] = null;
    room.playerLeaseExpiry[roleIdx] = 0;
    room.playerLeaseTimer[roleIdx] = null;
    console.log(`[WS] lease expired (role=${roleIdx}), no spectator to promote`);
  }
}

function startLeaseTimer(roomId, roleIdx){
  const room = rooms[roomId]; if (!room) return;
  if (room.playerLeaseTimer[roleIdx]) clearTimeout(room.playerLeaseTimer[roleIdx]);
  room.playerLeaseExpiry[roleIdx] = now() + ROLE_LEASE_MS;
  room.playerLeaseTimer[roleIdx] = setTimeout(() => onLeaseExpire(roomId, roleIdx), ROLE_LEASE_MS);
}

// ====== WebSocket (/ws) ======
const wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: false });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.roleIdx = null;
  ws.deviceId = null;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const type = msg?.type;

    // ---- join ----
    if (type === "join") {
      const roomId = String(msg.room || "room1");
      const deviceId = String(msg.deviceId || "");
      const room = getOrCreateRoom(roomId);
      ws.roomId = roomId;
      ws.deviceId = deviceId;

      // 1) 同一端末の優先権が有効で席が空なら即復帰
      for (let r=0; r<2; r++){
        if (!room.slots[r] &&
            room.playerToken[r] &&
            room.playerToken[r] === deviceId &&
            (room.playerLeaseExpiry[r] === 0 || now() < room.playerLeaseExpiry[r])) {
          assignRole(room, r, ws);
          send(ws, { type: "role", index: r });
          if (room.state) send(ws, { type: "syncState", state: room.state });
          console.log(`[WS] rejoin with token -> role=${r}`);
          return;
        }
      }
      // 2) 空席があり優先権が失効済みなら新規着席
      for (let r=0; r<2; r++){
        if (!room.slots[r] && (room.playerLeaseExpiry[r] === 0 || now() >= room.playerLeaseExpiry[r])) {
          assignRole(room, r, ws);
          send(ws, { type: "role", index: r });
          if (room.state) send(ws, { type: "syncState", state: room.state });
          console.log(`[WS] new seat -> role=${r}`);
          return;
        }
      }
      // 3) 観戦へ（先着キュー登録）
      enqueueSpectator(room, ws);
      ws.roleIdx = 2 + room.spectators.size - 1;
      send(ws, { type: "role", index: ws.roleIdx });
      if (room.state) send(ws, { type: "syncState", state: room.state });
      console.log(`[WS] join spectator (queue size ${room.specQueue.length})`);
      return;
    }

    // ---- request_state ----
    if (type === "request_state") {
      const room = rooms[ws.roomId];
      if (room?.state) send(ws, { type: "syncState", state: room.state });
      return;
    }

    // ---- syncState（完全スナップショット受信） ----
    if (type === "syncState") {
      const room = rooms[ws.roomId];
      if (!room) return;
      if (ws.roleIdx === 0 || ws.roleIdx === 1) {
        if (msg.state && typeof msg.state === "object") {
          room.state = msg.state;
          room.lastUpdated = now();
          broadcast(ws.roomId, { type: "syncState", state: room.state });
        }
      }
      return;
    }

    // ---- chat ----
    if (type === "chat") {
      const room = rooms[ws.roomId]; if (!room) return;
      const label = (ws.roleIdx === 0) ? "P1"
                 : (ws.roleIdx === 1) ? "P2"
                 : `観戦${ws.roleIdx}`;
      broadcast(ws.roomId, {
        type: "chat",
        from: label,
        text: String(msg.text || ""),
        time: msg.time || new Date().toLocaleTimeString(),
      });
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms[ws.roomId];
    if (!room) return;

    if (ws.roleIdx === 0 || ws.roleIdx === 1) {
      // プレイヤーが抜けた → 席を空けてリース猶予起動
      if (room.slots[ws.roleIdx] === ws) {
        room.slots[ws.roleIdx] = null;
        startLeaseTimer(ws.roomId, ws.roleIdx);
        console.log(`[WS] player left -> start lease timer role=${ws.roleIdx}`);
      }
    } else {
      room.spectators.delete(ws);
      // specQueue 側は昇格処理時に死体スキップでクリーンにする
    }

    const peers = (room.slots[0]?1:0) + (room.slots[1]?1:0) + room.spectators.size;
    console.log(`[WS] closed: room=${ws.roomId} peers=${peers}`);

    if (peers === 0) {
      const TTL = 15 * 60 * 1000; // 15分
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      room.cleanupTimer = setTimeout(() => {
        delete rooms[ws.roomId];
        console.log(`[WS] room ${ws.roomId} cleaned`);
      }, TTL);
    }
  });
});

// 心拍監視（モバイルのバックグラウンド落ち対策）
const interval = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, 30000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, HOST, () => {
  console.log(`[HTTP] listening on http://${HOST}:${PORT}  (wss path: /ws)`);
});