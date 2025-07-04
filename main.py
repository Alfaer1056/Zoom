from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from typing import Dict
import json

app = FastAPI()

# Хранилище комнат и подключений: { room_id: { client_id: websocket } }
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
                    # Рассылка всем кроме отправителя
                    if room_id in rooms:
                        for cid, ws in rooms[room_id].items():
                            if cid != client_id:
                                await ws.send_text(data)
                else:
                    if room_id in rooms and target_id in rooms[room_id]:
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
