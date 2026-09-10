"""Preview and explicitly confirm transaction imports from an unsupported bank.

This utility intentionally does not register an MCP tool. A CSV import changes
financial records, so it is performed only on the VPS by an operator who has
reviewed the preview and supplied its confirmation token.
"""

import argparse
import asyncio
import csv
import hashlib
import json
import sys
from dataclasses import asdict, dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, Sequence

from monarch_mcp_server.client import get_monarch_client

REQUIRED_COLUMNS = ("date", "amount", "merchant_name", "category_id")


@dataclass(frozen=True)
class ImportTransaction:
    """A validated CSV transaction ready for Monarch's create API."""

    date: str
    amount: str
    merchant_name: str
    category_id: str
    notes: str | None = None

    def api_payload(self, account_id: str, source_name: str) -> dict[str, Any]:
        note_prefix = f"Imported from {source_name}."
        notes = f"{note_prefix} {self.notes}" if self.notes else note_prefix
        return {
            "date": self.date,
            "account_id": account_id,
            "amount": float(self.amount),
            "merchant_name": self.merchant_name,
            "category_id": self.category_id,
            "notes": notes,
        }


def _required(value: str | None, column: str, row_number: int) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise ValueError(f"row {row_number}: {column} is required")
    return normalized


def _parse_row(row: dict[str, str | None], row_number: int) -> ImportTransaction:
    raw_date = _required(row.get("date"), "date", row_number)
    try:
        parsed_date = date.fromisoformat(raw_date)
    except ValueError as error:
        raise ValueError(f"row {row_number}: date must be YYYY-MM-DD") from error

    raw_amount = _required(row.get("amount"), "amount", row_number)
    try:
        amount = Decimal(raw_amount)
    except InvalidOperation as error:
        raise ValueError(f"row {row_number}: amount must be numeric") from error
    if not amount.is_finite() or amount == 0:
        raise ValueError(f"row {row_number}: amount must be non-zero and finite")

    notes = (row.get("notes") or "").strip() or None
    return ImportTransaction(
        date=parsed_date.isoformat(),
        amount=format(amount.normalize(), "f"),
        merchant_name=_required(row.get("merchant_name"), "merchant_name", row_number),
        category_id=_required(row.get("category_id"), "category_id", row_number),
        notes=notes,
    )


def load_csv(path: Path) -> list[ImportTransaction]:
    """Load a strict, UTF-8 CSV without changing any Monarch data."""
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError("CSV must contain a header row")
        missing = set(REQUIRED_COLUMNS).difference(reader.fieldnames)
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing))}")
        transactions = [_parse_row(row, index) for index, row in enumerate(reader, start=2)]

    if not transactions:
        raise ValueError("CSV contains no transactions")
    return transactions


def confirmation_token(account_id: str, transactions: Iterable[ImportTransaction]) -> str:
    """Produce the immutable token that binds preview confirmation to its rows."""
    canonical = json.dumps(
        {"account_id": account_id, "transactions": [asdict(row) for row in transactions]},
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def require_confirmation(apply: bool, supplied: str | None, expected: str) -> None:
    if not apply:
        return
    if supplied != expected:
        raise ValueError(
            "--apply requires --confirm with the confirmation_token from the preview"
        )


async def import_transactions(
    account_id: str,
    source_name: str,
    transactions: Sequence[ImportTransaction],
) -> list[Any]:
    client = await get_monarch_client()
    results: list[Any] = []
    for transaction in transactions:
        payload = transaction.api_payload(account_id, source_name)
        results.append(await client.create_transaction(**payload))
    return results


def _arguments() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_file", type=Path)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--source-name", help="Label placed in every imported note")
    parser.add_argument("--apply", action="store_true", help="Create the previewed transactions")
    parser.add_argument("--confirm", help="Confirmation token printed by preview")
    return parser


def main() -> None:
    args = _arguments().parse_args()
    try:
        transactions = load_csv(args.csv_file)
        token = confirmation_token(args.account_id, transactions)
        source_name = args.source_name or args.csv_file.name
        require_confirmation(args.apply, args.confirm, token)

        output: dict[str, Any] = {
            "account_id": args.account_id,
            "confirmation_token": token,
            "mode": "apply" if args.apply else "preview",
            "source_name": source_name,
            "transactions": [asdict(row) for row in transactions],
        }
        if args.apply:
            output["results"] = asyncio.run(
                import_transactions(args.account_id, source_name, transactions)
            )
        print(json.dumps(output, indent=2, default=str))
    except (OSError, ValueError) as error:
        print(f"Import not run: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
