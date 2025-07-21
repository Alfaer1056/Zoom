import os
import json
import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from typing import Dict

from starlette.middleware.wsgi import WSGIMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Mount
from starlette.types import ASGIApp, Receive, Scope, Send

from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

# ---------- FastAPI Setup ----------
app = FastAPI()

# Теперь словарь: room_id → client_id → {"ws": websocket, "name": username}
rooms: Dict[str, Dict[str, dict]] = {}
message_history: Dict[str, list] = {}  # Храним историю сообщений по комнатам
active_users = {}

class ConnectionManager:
    async def connect(self, room_id: str, client_id: str, websocket: WebSocket, user_name: str = None):
        await websocket.accept()
        if room_id not in rooms:
            rooms[room_id] = {}
        rooms[room_id][client_id] = {"ws": websocket, "name": user_name or client_id}

        users_list = [{"id": cid, "name": info["name"]} for cid, info in rooms[room_id].items()]

        await self.broadcast(room_id, {
            "type": "user_joined",
            "user_id": client_id,
            "users": users_list
        })

    async def disconnect(self, room_id: str, client_id: str):
        if room_id in rooms and client_id in rooms[room_id]:
            del rooms[room_id][client_id]

            if room_id in rooms:
                users_list = [{"id": cid, "name": info["name"]} for cid, info in rooms[room_id].items()]
                await self.broadcast(room_id, {
                    "type": "user_left",
                    "user_id": client_id,
                    "users": users_list
                })

            if room_id in rooms and not rooms[room_id]:
                del rooms[room_id]

    async def broadcast(self, room_id: str, message: dict):
        if room_id in rooms:
            for info in rooms[room_id].values():
                await info["ws"].send_text(json.dumps(message))

manager = ConnectionManager()

@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, client_id: str):
    user_name = client_id  # по умолчанию имя = id пользователя
    await manager.connect(room_id, client_id, websocket, user_name)

    # <-- ВСТАВИТЬ РЕГИСТРАЦИЮ active_users ЗДЕСЬ -->
    active_users.setdefault(room_id, {})[client_id] = websocket

    # Отправляем историю сообщений новому подключившемуся
    if room_id in message_history:
        for msg in message_history[room_id]:
            await websocket.send_text(json.dumps(msg))

    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)

            if message["type"] == "kick_user":
                target_id = message["target_id"]
                target_ws = active_users.get(room_id, {}).get(target_id)
                if not target_ws:
                    target_ws = rooms.get(room_id, {}).get("users", {}).get(target_id)

                if target_ws:
                    print(f"[KICK] Админ кикнул пользователя {target_id}")
                    await target_ws.send_text(json.dumps({"type": "kicked"}))
                    await asyncio.sleep(0.2)
                    await target_ws.close()

                    if room_id in active_users and target_id in active_users[room_id]:
                        del active_users[room_id][target_id]
                        if not active_users[room_id]:  # <-- УДАЛЯЕМ ПУСТУЮ КОМНАТУ
                            del active_users[room_id]

                    if room_id in rooms and "users" in rooms[room_id] and target_id in rooms[room_id]["users"]:
                        del rooms[room_id]["users"][target_id]

                    if room_id in rooms and "users" in rooms[room_id]:
                        for uid, ws in rooms[room_id]["users"].items():
                            await ws.send_text(json.dumps({
                                "type": "user_left",
                                "user_id": target_id,
                                "user_name": rooms[room_id].get("usernames", {}).get(target_id, "")
                            }))
                else:
                    print(f"[KICK] Не найден пользователь {target_id} в комнате {room_id}")
                continue

                # Ищем пользователя в комнате
                target_ws = rooms[room_id]["users"].get(target_id)
                if target_ws:
                    # Сообщаем кикнутому
                    await target_ws.send_text(json.dumps({
                        "type": "kicked",
                        "reason": "Вы были кикнуты администратором"
                    }))
                    await target_ws.close()

                    # Удаляем из комнаты
                    del rooms[room_id]["users"][target_id]

                    # Сообщаем остальным, что этот пользователь вышел
                    for uid, ws in rooms[room_id]["users"].items():
                        await ws.send_text(json.dumps({
                            "type": "user_left",
                            "user_id": target_id,
                            "user_name": rooms[room_id]["usernames"].get(target_id, "")
                        }))
                    continue  # Не обрабатывать остальную логику для этого сообщения

            msg_type = message.get("type")

            # Сохраняем в историю нужные сообщения
            if msg_type in ["chat_message", "file_transfer", "image_transfer"]:
                message_history.setdefault(room_id, []).append(message)

            # Ретрансляция сообщений
            if msg_type in ["webrtc_offer", "webrtc_answer", "ice_candidate"]:
                if target_id in rooms.get(room_id, {}):
                    await rooms[room_id][target_id]["ws"].send_text(data)

            elif msg_type in ["chat_message", "file_transfer", "image_transfer"]:
                for cid, info in rooms.get(room_id, {}).items():
                    if cid != client_id:
                        await info["ws"].send_text(data)

    except WebSocketDisconnect:
        await manager.disconnect(room_id, client_id)

    # Очистка истории, если комната пустая
    if room_id in rooms and not rooms[room_id]:
        message_history.pop(room_id, None)


@app.get("/api/rooms/{room_id}/exists")
async def room_exists(room_id: str):
    return {"exists": room_id in rooms}

from fastapi.responses import JSONResponse
from fastapi import Request

@app.post("/api/rooms/create")
async def create_room(request: Request):
    data = await request.json()
    room = data.get("room")
    user = data.get("user")
    if not room or not user:
        return JSONResponse({"detail": "Missing room or user"}, status_code=400)
    return JSONResponse({"status": "ok"})


@app.get("/")
async def root():
    return RedirectResponse(url="/lobby.html")

app.mount("/", StaticFiles(directory="static", html=True), name="static")

# ---------- AIOHTTP WebRTC Setup ----------
pcs = set()
aio_routes = web.RouteTableDef()

@aio_routes.get("/serv.html")
async def index(request):
    with open(os.path.join("static", "serv.html"), "r") as f:
        return web.Response(content_type="text/html", text=f.read())

@aio_routes.post("/offer")
async def offer(request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pcs.add(pc)

    @pc.on("iceconnectionstatechange")
    def on_iceconnectionstatechange():
        print("ICE connection state is %s" % pc.iceConnectionState)
        if pc.iceConnectionState == "failed":
            asyncio.ensure_future(pc.close())
            pcs.discard(pc)

    player = MediaPlayer("demo.mp4")
    if player.video:
        pc.addTrack(player.video)

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        })
    )

aio_app = web.Application()
aio_app.add_routes(aio_routes)

# ---------- ASGI middleware to embed aiohttp ----------
class AioHttpMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp):
        super().__init__(app)
        self.aiohandler = aio_app._make_handler()
        self.runner = web.AppRunner(aio_app)
        asyncio.get_event_loop().run_until_complete(self.runner.setup())
        self.site = web.TCPSite(self.runner, port=None)  # embedded mode

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith("/offer") or path.startswith("/serv.html"):
            req = await self.runner.server.request_handler(request.scope, request.receive, request.send)
            return req
        return await call_next(request)

# (Этот middleware не полностью стабилен — лучше запускать aiohttp отдельно)

# ---------- Запуск ----------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", port=8000, reload=True)