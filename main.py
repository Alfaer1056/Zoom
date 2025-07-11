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
rooms: Dict[str, Dict[str, WebSocket]] = {}

class ConnectionManager:
    async def connect(self, room_id: str, client_id: str, websocket: WebSocket):
        await websocket.accept()
        if room_id not in rooms:
            rooms[room_id] = {}
        rooms[room_id][client_id] = websocket
        await self.broadcast(room_id, {
            "type": "user_joined",
            "user_id": client_id,
            "users": list(rooms[room_id].keys())
        })

    async def disconnect(self, room_id: str, client_id: str):
        if room_id in rooms and client_id in rooms[room_id]:
            del rooms[room_id][client_id]
            await self.broadcast(room_id, {
                "type": "user_left",
                "user_id": client_id,
                "users": list(rooms[room_id].keys()) if room_id in rooms else []
            })
            if room_id in rooms and not rooms[room_id]:
                del rooms[room_id]

    async def broadcast(self, room_id: str, message: dict):
        if room_id in rooms:
            for ws in rooms[room_id].values():
                await ws.send_text(json.dumps(message))

manager = ConnectionManager()

@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, client_id: str):
    await manager.connect(room_id, client_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            if message["type"] in ["webrtc_offer", "webrtc_answer", "webrtc_candidate", "chat_message"]:
                target_id = message.get("target_id")
                if message["type"] == "chat_message":
                    for cid, ws in rooms.get(room_id, {}).items():
                        if cid != client_id:
                            await ws.send_text(data)
                else:
                    if target_id in rooms.get(room_id, {}):
                        await rooms[room_id][target_id].send_text(data)
    except WebSocketDisconnect:
        await manager.disconnect(room_id, client_id)

@app.get("/api/rooms/{room_id}/exists")
async def room_exists(room_id: str):
    return {"exists": room_id in rooms}

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

# (ОБРАТИ ВНИМАНИЕ: этот middleware не полностью стабилен — лучше запускать aiohttp отдельно)

# ---------- Запуск ----------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", port=8000, reload=True)
