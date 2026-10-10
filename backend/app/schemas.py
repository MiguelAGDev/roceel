from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

# El motivo no puede venir vacío ni solo con espacios (contrato: 422).
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ResolveIn(BaseModel):
    part_id: int
    location_id: int | None = None  # si falta, la ubicación de recepción (U-100)


class IssueIn(BaseModel):
    work_order_code: str
    part_id: int
    location_id: int
    quantity: int = Field(ge=1)
    issued_by: int | str


class TransferIn(BaseModel):
    part_id: int
    from_location_id: int
    to_location_id: int
    quantity: int = Field(ge=1)


class CountLine(BaseModel):
    part_id: int
    counted_quantity: int = Field(ge=0)


class CountIn(BaseModel):
    location_id: int
    reason: Reason
    lines: list[CountLine]
