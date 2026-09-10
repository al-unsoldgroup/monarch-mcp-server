from pathlib import Path

import pytest

from monarch_mcp_server.transaction_import import (
    confirmation_token,
    load_csv,
    require_confirmation,
)


def _write_csv(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "bank.csv"
    path.write_text(content, encoding="utf-8")
    return path


def test_preview_rows_are_normalized_and_token_is_stable(tmp_path: Path) -> None:
    path = _write_csv(
        tmp_path,
        "date,amount,merchant_name,category_id,notes\n2026-09-01,-12.50,Coffee,cat-1,Receipt 8\n",
    )

    rows = load_csv(path)

    assert rows[0].amount == "-12.5"
    assert confirmation_token("account-1", rows) == confirmation_token("account-1", rows)


def test_csv_requires_valid_nonzero_amount(tmp_path: Path) -> None:
    path = _write_csv(
        tmp_path,
        "date,amount,merchant_name,category_id\n2026-09-01,0,Coffee,cat-1\n",
    )

    with pytest.raises(ValueError, match="non-zero"):
        load_csv(path)


def test_apply_requires_preview_confirmation() -> None:
    with pytest.raises(ValueError, match="--apply requires --confirm"):
        require_confirmation(True, "wrong", "correct")

    require_confirmation(True, "correct", "correct")
