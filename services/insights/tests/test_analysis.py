"""Data-governance / model-risk tests for the analysis layer.

The @pytest.mark.control tests guard the properties that make a client-facing figure
shippable under CLAUDE.md: reproducibility, provenance/disclosure, and clean data.
"""
import pytest
from app import analysis


@pytest.mark.control
def test_cleaning_is_deterministic():
    """Same inputs must yield identical output — a reproducibility requirement (SR 11-7)."""
    assert analysis.build_frame().equals(analysis.build_frame())


def test_inflation_is_year_over_year():
    """Derived inflation must be YoY % change (a plausible band), not the raw CPI index."""
    values = [p["value"] for p in analysis.series_view("INFLATION")["points"]]
    assert all(-15.0 <= v <= 25.0 for v in values)


@pytest.mark.control
def test_inflation_unemployment_view_is_deterministic_and_consistent():
    """SCRUM-7 — the paired view must reproduce exactly and stay consistent with build_frame().

    Reproducibility (SR 11-7): same inputs, same output, every call.
    Consistency: as_of/disclaimer must match the underlying frame, not drift from it.
    """
    first = analysis.inflation_unemployment_view()
    second = analysis.inflation_unemployment_view()
    assert first == second

    frame = analysis.build_frame()
    assert first["as_of"] == frame.index.max().date().isoformat()
    assert first["disclaimer"] == analysis.DISCLAIMER
    assert len(first["points"]) == len(frame)
