from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import db, repo
from .config import CORS_ORIGINS, UI_DIR
from .domain import Conflict, NotFound
from .schemas import CountIn, IssueIn, ResolveIn, TransferIn


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.pool.open(wait=False)
    yield
    db.pool.close()


app = FastAPI(title="Servicio de inventario del taller", lifespan=lifespan)

# Sin esto el navegador bloquea las llamadas del frontend (otro origen, p. ej. Vite en :5173).
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])


# El contrato pide errores como {"detail": "<mensaje>"} (FastAPI manda una lista por defecto).
@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    detail = "; ".join(f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors())
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(NotFound)
async def not_found(request: Request, exc: NotFound):
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(Conflict)
async def conflict(request: Request, exc: Conflict):
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.get("/health")
def health():
    ok = db.ping()
    return JSONResponse(status_code=200 if ok else 503, content={"db": ok})


@app.get("/parts/{part_id}/availability")
def availability(part_id: int):
    result = repo.get_availability(part_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"la pieza {part_id} no existe")
    return result


@app.get("/parts/{part_id}/ledger")
def ledger(part_id: int):
    result = repo.get_ledger(part_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"la pieza {part_id} no existe")
    return result


@app.get("/work-orders/{code}/materials")
def materials(code: str):
    result = repo.get_materials(code)
    if result is None:
        raise HTTPException(status_code=404, detail=f"la orden {code} no existe")
    return result


@app.get("/shortages")
def shortages(work_order_code: str | None = None, part_id: int | None = None):
    return repo.list_shortages(work_order_code, part_id)


@app.get("/reorder-suggestions")
def reorder_suggestions():
    return repo.list_reorder_suggestions()


@app.get("/unmatched-receipts")
def unmatched_receipts():
    return repo.list_unmatched_receipts()


@app.post("/unmatched-receipts/{receipt_id}/resolve")
def resolve(receipt_id: str, body: ResolveIn):
    return repo.resolve_receipt(receipt_id, body.part_id, body.location_id)


@app.post("/issues", status_code=201)
def issues(body: IssueIn):
    return repo.issue(body.work_order_code, body.part_id, body.location_id, body.quantity, body.issued_by)


@app.post("/transfers", status_code=201)
def transfers(body: TransferIn):
    return repo.transfer(body.part_id, body.from_location_id, body.to_location_id, body.quantity)


@app.post("/counts", status_code=201)
def counts(body: CountIn):
    return repo.count(body.location_id, body.reason, body.lines)


# --- Rutas extra para las pantallas (el contrato permite agregar rutas, no cambiar las suyas) ---

@app.get("/parts")
def parts(q: str | None = None):
    return repo.list_parts(q)


@app.get("/parts/{part_id}")
def part(part_id: int):
    result = repo.get_part(part_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"la pieza {part_id} no existe")
    return result


@app.get("/parts/{part_id}/policy")
def policy(part_id: int):
    result = repo.get_policy(part_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"la pieza {part_id} no existe")
    return result


@app.get("/parts/{part_id}/work-orders")
def part_work_orders(part_id: int):
    result = repo.part_work_orders(part_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"la pieza {part_id} no existe")
    return result


# `:path` porque los SKU traen diagonales (`7014 CTA/P4`) y llegan decodificadas a la ruta.
@app.get("/scan/{code:path}")
def scan(code: str):
    result = repo.scan(code)
    if result is None:
        raise HTTPException(status_code=404, detail=f"el código {code} no corresponde a ninguna pieza ni ubicación")
    return result


@app.get("/locations")
def locations():
    return repo.list_locations()


@app.get("/work-orders")
def work_orders():
    return repo.list_work_orders()


@app.get("/dashboard")
def dashboard():
    return repo.dashboard()


# Las pantallas (frontend/ compilado) se sirven aquí mismo: un solo origen, sin CORS.
@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/ui/")


class UIFiles(StaticFiles):
    """index.html se revalida siempre (así un rebuild llega a los celulares sin borrar caché); los archivos
    de assets/ llevan hash en el nombre y se pueden guardar para siempre."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        immutable = path.startswith("assets/")
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return response


if UI_DIR.is_dir():
    app.mount("/ui", UIFiles(directory=UI_DIR, html=True), name="ui")
