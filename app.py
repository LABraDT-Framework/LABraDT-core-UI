"""Stable launcher: run `python app.py` from V0.9.1."""
import os
import uvicorn
from backend.app import app

if __name__ == "__main__":
    uvicorn.run(app, host=os.getenv("UI_HOST", "0.0.0.0"), port=int(os.getenv("UI_PORT", "8090")))
