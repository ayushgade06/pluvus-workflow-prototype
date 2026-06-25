"""Unit tests for draft-copy hardening (brand leak + currency drift).

Covers the pure helpers behind three reported bugs:
  * `_format_rate` — fixed-currency USD rendering so the model can't drift $→£.
  * `_scrub_brand` — maps a stray "Pluvus" the model emits back to the real
    campaign sender (e.g. Barclays), and fills bracketed placeholders.

Pure functions, no LLM / no network.
"""

import pytest

from app.routes.negotiate import _format_rate, _scrub_brand


# ---------------------------------------------------------------------------
# _format_rate — always "$", integers without trailing .0
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        (350, "$350"),
        (350.0, "$350"),
        (480.5, "$480.5"),
        ("480", "$480"),
        ("$480", "$480"),
        ("1,500", "$1500"),
        (None, None),
        ("", None),
        ("abc", None),
        (True, None),  # bool must not render as $1
    ],
)
def test_format_rate(raw, expected):
    assert _format_rate(raw) == expected


# ---------------------------------------------------------------------------
# _scrub_brand — stray Pluvus → real sender (when sender isn't Pluvus)
# ---------------------------------------------------------------------------


def test_scrub_maps_stray_pluvus_to_sender():
    body = "Thanks for partnering with Pluvus! Best, Pluvus"
    out = _scrub_brand(body, "Barclays")
    assert "Pluvus" not in out
    assert out.count("Barclays") == 2


def test_scrub_maps_pluvus_partnerships_phrase():
    body = "We at Pluvus Partnerships are excited."
    out = _scrub_brand(body, "Barclays")
    assert "Pluvus" not in out
    assert "Barclays" in out


def test_scrub_leaves_pluvus_when_sender_is_pluvus():
    """When the campaign brand genuinely IS Pluvus, don't mangle it."""
    body = "Welcome to Pluvus!"
    out = _scrub_brand(body, "Pluvus Partnerships")
    assert "Pluvus" in out


def test_scrub_fills_bracketed_placeholders():
    body = "Hi, [Name] here from [Brand]. Best,\n[Your Name]"
    out = _scrub_brand(body, "Barclays")
    assert "[Name]" not in out
    assert "[Brand]" not in out
    assert "[Your Name]" not in out
    assert "Barclays" in out


def test_scrub_does_not_touch_unrelated_text():
    body = "We loved your fitness content, Alex. Best, Barclays"
    out = _scrub_brand(body, "Barclays")
    assert out == body
