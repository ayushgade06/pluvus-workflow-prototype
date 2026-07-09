from pathlib import Path
from dotenv import load_dotenv
# Load from repo root (.env sits one level above agent/)
load_dotenv(Path(__file__).parent.parent.parent / ".env")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.classify import router as classify_router
from app.routes.negotiate import router as negotiate_router

app = FastAPI(title="Pluvus Agent Service", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "agent"}


@app.get("/metrics")
def metrics() -> dict:
    """HARD-O1: the code-side metrics surface. Returns a coarse aggregate over the
    in-process LLM-call ring buffer (call count, error rate, latency, token + cost
    totals). This is the SCAFFOLDING seam a real monitoring backend scrapes — the
    acceptance criterion (dashboards + alert routing) is the infra behind it, not
    this endpoint. Auth for this endpoint is the parent system's perimeter job
    (see the CRITICAL-5 scope note)."""
    from app.telemetry import summary

    return summary()


app.include_router(classify_router)
app.include_router(negotiate_router)
