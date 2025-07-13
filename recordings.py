from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
router = APIRouter()
RECORDINGS_DIR = Path("private_recordings")
def get_current_user():
    return {"username": "demo"}
def user_has_access(user, recording_id):
    return True
@router.get("/recordings/{recording_id}")
def get_recording(recording_id: str, user=Depends(get_current_user)):
    if not user_has_access(user, recording_id):
        raise HTTPException(status_code=403, detail="Access denied")
    filepath = RECORDINGS_DIR / f"{recording_id}.mp4"
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Recording not found")
    return FileResponse(filepath, media_type="video/mp4")