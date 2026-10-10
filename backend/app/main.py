from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import db, repo
from .schemas import CountIn, IssueIn, ResolveIn, TransferIn


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.pool.open(wait=False)
    yield
    db.pool.close()


app = FastAPI(title="Servicio de inventario del taller", lifespan=lifespan)


# El contrato pide errores como {"detail": "<mensaje>"} (FastAPI manda una lista por defecto).
@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    detail = "; ".join(f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors())
    return JSONResponse(status_code=422, content={"detail": detail})


@app.get("/health")
def health():
    ok = db.ping()
    return JSONResponse(status_code=200 if ok else 503, content={"db": ok})


@app.get("/parts/{part_id}/availability")
def availability(part_id: int):
    return repo.get_availability(part_id)


@app.get("/parts/{part_id}/ledger")
def ledger(part_id: int):
    return repo.get_ledger(part_id)


@app.get("/work-orders/{code}/materials")
def materials(code: str):
    return repo.get_materials(code)


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
